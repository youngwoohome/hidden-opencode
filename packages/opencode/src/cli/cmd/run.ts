import type { Argv } from "yargs"
import path from "path"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { Flag } from "../../flag/flag"
import { bootstrap } from "../bootstrap"
import { Command } from "../../command"
import { EOL } from "os"
import { select } from "@clack/prompts"
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2"
import { Server } from "../../server/server"
import { Provider } from "../../provider/provider"
import { Agent } from "../../agent/agent"

const TOOL: Record<string, [string, string]> = {
  todowrite: ["Todo", UI.Style.TEXT_WARNING_BOLD],
  todoread: ["Todo", UI.Style.TEXT_WARNING_BOLD],
  bash: ["Bash", UI.Style.TEXT_DANGER_BOLD],
  edit: ["Edit", UI.Style.TEXT_SUCCESS_BOLD],
  glob: ["Glob", UI.Style.TEXT_INFO_BOLD],
  grep: ["Grep", UI.Style.TEXT_INFO_BOLD],
  list: ["List", UI.Style.TEXT_INFO_BOLD],
  read: ["Read", UI.Style.TEXT_HIGHLIGHT_BOLD],
  write: ["Write", UI.Style.TEXT_SUCCESS_BOLD],
  websearch: ["Search", UI.Style.TEXT_DIM_BOLD],
}

export const RunCommand = cmd({
  command: "run [message..]",
  describe: "run opencode with a message",
  builder: (yargs: Argv) => {
    return yargs
      .positional("message", {
        describe: "message to send",
        type: "string",
        array: true,
        default: [],
      })
      .option("command", {
        describe: "the command to run, use message for args",
        type: "string",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        describe: "session id to continue",
        type: "string",
      })
      .option("share", {
        type: "boolean",
        describe: "share the session",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("format", {
        type: "string",
        choices: ["default", "json"],
        default: "default",
        describe: "format: default (formatted) or json (raw JSON events)",
      })
      .option("file", {
        alias: ["f"],
        type: "string",
        array: true,
        describe: "file(s) to attach to message",
      })
      .option("title", {
        type: "string",
        describe: "title for the session (uses truncated prompt if no value provided)",
      })
      .option("attach", {
        type: "string",
        describe: "attach to a running opencode server (e.g., http://localhost:4096)",
      })
      .option("poll", {
        type: "boolean",
        describe: "poll for session updates instead of SSE (useful when SSE is blocked)",
      })
      .option("port", {
        type: "number",
        describe: "port for the local server (defaults to random port if no value provided)",
      })
      .option("variant", {
        type: "string",
        describe: "model variant (provider-specific reasoning effort, e.g., high, max, minimal)",
      })
  },
  handler: async (args) => {
    let message = [...args.message, ...(args["--"] || [])]
      .map((arg) => (arg.includes(" ") ? `"${arg.replace(/"/g, '\\"')}"` : arg))
      .join(" ")

    const fileParts: any[] = []
    if (args.file) {
      const files = Array.isArray(args.file) ? args.file : [args.file]

      for (const filePath of files) {
        const resolvedPath = path.resolve(process.cwd(), filePath)
        const file = Bun.file(resolvedPath)
        const stats = await file.stat().catch(() => {})
        if (!stats) {
          UI.error(`File not found: ${filePath}`)
          process.exit(1)
        }
        if (!(await file.exists())) {
          UI.error(`File not found: ${filePath}`)
          process.exit(1)
        }

        const stat = await file.stat()
        const mime = stat.isDirectory() ? "application/x-directory" : "text/plain"

        fileParts.push({
          type: "file",
          url: `file://${resolvedPath}`,
          filename: path.basename(resolvedPath),
          mime,
        })
      }
    }

    if (!process.stdin.isTTY) message += "\n" + (await Bun.stdin.text())

    if (message.trim().length === 0 && !args.command) {
      UI.error("You must provide a message or a command")
      process.exit(1)
    }

    const execute = async (sdk: OpencodeClient, sessionID: string) => {
      const printEvent = (color: string, type: string, title: string) => {
        UI.println(
          color + `|`,
          UI.Style.TEXT_NORMAL + UI.Style.TEXT_DIM + ` ${type.padEnd(7, " ")}`,
          "",
          UI.Style.TEXT_NORMAL + title,
        )
      }

      const outputJsonEvent = (type: string, data: any) => {
        if (args.format === "json") {
          process.stdout.write(JSON.stringify({ type, timestamp: Date.now(), sessionID, ...data }) + EOL)
          return true
        }
        return false
      }

      let errorMsg: string | undefined
      let sawIdle = false
      const seenPartIDs = new Set<string>()
      const seenMessageErrors = new Set<string>()
      const seenPermissionIDs = new Set<string>()

      const handlePart = (part: any) => {
        if (seenPartIDs.has(part.id)) return

        if (part.type === "tool" && part.state.status === "completed") {
          if (outputJsonEvent("tool_use", { part })) {
            seenPartIDs.add(part.id)
            return
          }
          const [tool, color] = TOOL[part.tool] ?? [part.tool, UI.Style.TEXT_INFO_BOLD]
          const input = part.state.input ?? {}
          const title = part.state.title || (Object.keys(input).length > 0 ? JSON.stringify(input) : "Unknown")
          printEvent(color, tool, title)
          if (part.tool === "bash" && part.state.output?.trim()) {
            UI.println()
            UI.println(part.state.output)
          }
          seenPartIDs.add(part.id)
          return
        }

        if (part.type === "step-start") {
          if (outputJsonEvent("step_start", { part })) {
            seenPartIDs.add(part.id)
            return
          }
          seenPartIDs.add(part.id)
          return
        }

        if (part.type === "step-finish") {
          if (outputJsonEvent("step_finish", { part })) {
            seenPartIDs.add(part.id)
            return
          }
          seenPartIDs.add(part.id)
          return
        }

        if (part.type === "text" && part.time?.end) {
          if (outputJsonEvent("text", { part })) {
            seenPartIDs.add(part.id)
            return
          }
          const isPiped = !process.stdout.isTTY
          if (!isPiped) UI.println()
          process.stdout.write((isPiped ? part.text : UI.markdown(part.text)) + EOL)
          if (!isPiped) UI.println()
          seenPartIDs.add(part.id)
        }
      }

      const handleMessageError = (info: any) => {
        if (info.role !== "assistant" || !info.error) return
        if (seenMessageErrors.has(info.id)) return
        let err = String(info.error.name ?? "Error")
        if ("data" in info.error && info.error.data && "message" in info.error.data) {
          err = String(info.error.data.message)
        }
        seenMessageErrors.add(info.id)
        errorMsg = errorMsg ? errorMsg + EOL + err : err
        if (outputJsonEvent("error", { error: info.error })) return
        UI.error(err)
      }

      const handlePermission = async (permission: any) => {
        if (permission.sessionID !== sessionID) return
        if (seenPermissionIDs.has(permission.id)) return
        const result = await select({
          message: `Permission required: ${permission.permission} (${permission.patterns.join(", ")})`,
          options: [
            { value: "once", label: "Allow once" },
            { value: "always", label: "Always allow: " + permission.always.join(", ") },
            { value: "reject", label: "Reject" },
          ],
          initialValue: "once",
        }).catch(() => "reject")
        const response = (result.toString().includes("cancel") ? "reject" : result) as "once" | "always" | "reject"
        await sdk.permission.respond({
          sessionID,
          permissionID: permission.id,
          response,
        })
        seenPermissionIDs.add(permission.id)
      }

      const pollEvents = async () => {
        const rawInterval = Number.parseInt(process.env.OPENCODE_POLL_INTERVAL_MS ?? "1000", 10)
        const intervalMs = Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : 1000

        while (true) {
          const [statusResult, messagesResult, permissionsResult] = await Promise.all([
            sdk.session.status().catch(() => undefined),
            sdk.session.messages({ sessionID, limit: 100 }).catch(() => undefined),
            sdk.permission.list().catch(() => undefined),
          ])

          const messages = messagesResult?.data ?? []
          for (const message of messages) {
            handleMessageError(message.info)
            for (const part of message.parts) {
              handlePart(part)
            }
          }

          const permissions = permissionsResult?.data ?? []
          for (const permission of permissions) {
            if (permission.sessionID !== sessionID) continue
            await handlePermission(permission)
          }

          const fallbackStatus = (() => {
            const lastMessage = messages.at(-1)?.info
            if (!lastMessage) return { type: "idle" as const }
            if (lastMessage.role === "assistant") {
              return lastMessage.time?.completed ? { type: "idle" as const } : { type: "busy" as const }
            }
            return { type: "busy" as const }
          })()
          const status = statusResult?.data?.[sessionID] ?? fallbackStatus
          if (status.type === "idle") break

          await Bun.sleep(intervalMs)
        }
      }

      let eventProcessor: Promise<void> | undefined
      if (!args.poll) {
        const events = await sdk.event
          .subscribe(
            {},
            args.attach
              ? {
                  sseMaxRetryAttempts: 0,
                }
              : undefined,
          )
          .catch(() => undefined)

        if (events) {
          eventProcessor = (async () => {
            for await (const event of events.stream) {
              if (event.type === "message.part.updated") {
                const part = event.properties.part
                if (part.sessionID !== sessionID) continue
                handlePart(part)
              }

              if (event.type === "session.error") {
                const props = event.properties
                if (props.sessionID !== sessionID || !props.error) continue
                let err = String(props.error.name)
                if ("data" in props.error && props.error.data && "message" in props.error.data) {
                  err = String(props.error.data.message)
                }
                errorMsg = errorMsg ? errorMsg + EOL + err : err
                if (outputJsonEvent("error", { error: props.error })) continue
                UI.error(err)
              }

              if (event.type === "session.idle" && event.properties.sessionID === sessionID) {
                sawIdle = true
                break
              }

              if (event.type === "permission.asked") {
                const permission = event.properties
                if (permission.sessionID !== sessionID) continue
                await handlePermission(permission)
              }
            }
          })()
        }
      }

      // Validate agent if specified
      const resolvedAgent = await (async () => {
        if (!args.agent) return undefined
        const agent = await Agent.get(args.agent)
        if (!agent) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${args.agent}" not found. Falling back to default agent`,
          )
          return undefined
        }
        if (agent.mode === "subagent") {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${args.agent}" is a subagent, not a primary agent. Falling back to default agent`,
          )
          return undefined
        }
        return args.agent
      })()

      if (args.command) {
        await sdk.session.command({
          sessionID,
          agent: resolvedAgent,
          model: args.model,
          command: args.command,
          arguments: message,
          variant: args.variant,
        })
      } else {
        const modelParam = args.model ? Provider.parseModel(args.model) : undefined
        // In remote attach mode (Modal/etc), the HTTP edge may enforce request timeouts for long
        // responses. Trigger asynchronously and rely on SSE `/event` to stream results.
        await sdk.session.promptAsync({
          sessionID,
          agent: resolvedAgent,
          model: modelParam,
          variant: args.variant,
          parts: [...fileParts, { type: "text", text: message }],
        })
      }

      if (args.poll || !eventProcessor) {
        await pollEvents()
        if (errorMsg) process.exit(1)
        return
      }

      await eventProcessor
      if (!sawIdle) {
        await pollEvents()
      }
      if (errorMsg) process.exit(1)
    }

    if (args.attach) {
      const sdk = createOpencodeClient({ baseUrl: args.attach })

      const sessionID = await (async () => {
        if (args.continue) {
          const result = await sdk.session.list()
          return result.data?.find((s) => !s.parentID)?.id
        }
        if (args.session) return args.session

        const title =
          args.title !== undefined
            ? args.title === ""
              ? message.slice(0, 50) + (message.length > 50 ? "..." : "")
              : args.title
            : undefined

        const result = await sdk.session.create(
          title
            ? {
                title,
                permission: [
                  {
                    permission: "question",
                    action: "deny",
                    pattern: "*",
                  },
                ],
              }
            : {
                permission: [
                  {
                    permission: "question",
                    action: "deny",
                    pattern: "*",
                  },
                ],
              },
        )
        return result.data?.id
      })()

      if (!sessionID) {
        UI.error("Session not found")
        process.exit(1)
      }

      const cfgResult = await sdk.config.get()
      if (cfgResult.data && (cfgResult.data.share === "auto" || Flag.OPENCODE_AUTO_SHARE || args.share)) {
        const shareResult = await sdk.session.share({ sessionID }).catch((error) => {
          if (error instanceof Error && error.message.includes("disabled")) {
            UI.println(UI.Style.TEXT_DANGER_BOLD + "!  " + error.message)
          }
          return { error }
        })
        if (!shareResult.error && "data" in shareResult && shareResult.data?.share?.url) {
          UI.println(UI.Style.TEXT_INFO_BOLD + "~  " + shareResult.data.share.url)
        }
      }

      return await execute(sdk, sessionID)
    }

    await bootstrap(process.cwd(), async () => {
      const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        return Server.App().fetch(request)
      }) as typeof globalThis.fetch
      const sdk = createOpencodeClient({ baseUrl: "http://opencode.internal", fetch: fetchFn })

      if (args.command) {
        const exists = await Command.get(args.command)
        if (!exists) {
          UI.error(`Command "${args.command}" not found`)
          process.exit(1)
        }
      }

      const sessionID = await (async () => {
        if (args.continue) {
          const result = await sdk.session.list()
          return result.data?.find((s) => !s.parentID)?.id
        }
        if (args.session) return args.session

        const title =
          args.title !== undefined
            ? args.title === ""
              ? message.slice(0, 50) + (message.length > 50 ? "..." : "")
              : args.title
            : undefined

        const result = await sdk.session.create(title ? { title } : {})
        return result.data?.id
      })()

      if (!sessionID) {
        UI.error("Session not found")
        process.exit(1)
      }

      const cfgResult = await sdk.config.get()
      if (cfgResult.data && (cfgResult.data.share === "auto" || Flag.OPENCODE_AUTO_SHARE || args.share)) {
        const shareResult = await sdk.session.share({ sessionID }).catch((error) => {
          if (error instanceof Error && error.message.includes("disabled")) {
            UI.println(UI.Style.TEXT_DANGER_BOLD + "!  " + error.message)
          }
          return { error }
        })
        if (!shareResult.error && "data" in shareResult && shareResult.data?.share?.url) {
          UI.println(UI.Style.TEXT_INFO_BOLD + "~  " + shareResult.data.share.url)
        }
      }

      await execute(sdk, sessionID)
    })
  },
})
