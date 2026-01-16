import z from "zod"
import { spawn } from "child_process"
import { Tool } from "./tool"
import path from "path"
import DESCRIPTION from "./bash.txt"
import { Log } from "../util/log"
import { Instance } from "../project/instance"
import { lazy } from "@/util/lazy"
import { Language } from "web-tree-sitter"

import { $ } from "bun"
import { Filesystem } from "@/util/filesystem"
import { fileURLToPath } from "url"
import { Flag } from "@/flag/flag.ts"
import { Shell } from "@/shell/shell"

import { BashArity } from "@/permission/arity"
import { Truncate } from "./truncation"
import { BashSafety } from "./bash-safety"
import { NetworkSafety } from "./network-safety"

const MAX_METADATA_LENGTH = 30_000
const DEFAULT_TIMEOUT = Flag.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 2 * 60 * 1000
const MAX_TIMEOUT = Flag.OPENCODE_EXPERIMENTAL_BASH_MAX_TIMEOUT_MS || 10 * 60 * 1000

export const log = Log.create({ service: "bash-tool" })

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const bashLanguage = await Language.load(bashPath)
  const p = new Parser()
  p.setLanguage(bashLanguage)
  return p
})

function safeText(result: { text: () => string }) {
  try {
    return result.text().trim()
  } catch {
    return ""
  }
}

function parseGithubRepo(url: string) {
  const trimmed = url.trim()
  const match = trimmed.match(/github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/i)
  if (!match?.groups) return undefined
  return { owner: match.groups.owner, name: match.groups.repo }
}

async function resolveGitInfo(cwd: string) {
  const remoteUrl =
    process.env.OPENCODE_REPO_URL ||
    safeText(await $`git remote get-url origin`.cwd(cwd).quiet().nothrow())
  if (!remoteUrl) return undefined
  const repo = parseGithubRepo(remoteUrl)
  if (!repo) return undefined

  let head = safeText(await $`git rev-parse --abbrev-ref HEAD`.cwd(cwd).quiet().nothrow())
  if (!head || head === "HEAD") {
    head = safeText(await $`git branch --show-current`.cwd(cwd).quiet().nothrow())
  }
  const commitSha = safeText(await $`git rev-parse HEAD`.cwd(cwd).quiet().nothrow())
  let baseRef = safeText(await $`git symbolic-ref --short refs/remotes/origin/HEAD`.cwd(cwd).quiet().nothrow())
  if (baseRef.startsWith("origin/")) baseRef = baseRef.slice("origin/".length)
  const base = baseRef || "main"

  if (!head || !commitSha) return undefined
  return { repo, head, base, commitSha }
}

async function configureGitHubAppPush(cwd: string) {
  const token = process.env.OPENCODE_GITHUB_APP_TOKEN?.trim()
  if (!token) return

  const remoteUrl = safeText(await $`git remote get-url origin`.cwd(cwd).quiet().nothrow())
  if (!remoteUrl || !/github\.com[:/]/i.test(remoteUrl)) return

  const config = "http.https://github.com/.extraheader"
  const credentials = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")
  const result = await $`git config --local ${config} "AUTHORIZATION: basic ${credentials}"`
    .cwd(cwd)
    .quiet()
    .nothrow()
  if (result.exitCode !== 0) {
    log.warn("failed to configure github app token", { exitCode: result.exitCode })
  }
}

async function reportSandboxPush(ctx: Tool.Context, cwd: string) {
  const apiUrl = process.env.OPENCODE_API_URL?.trim()
  const secret = process.env.OPENCODE_SANDBOX_EVENT_SECRET?.trim()
  if (!apiUrl || !secret) {
    return
  }
  const info = await resolveGitInfo(cwd)
  if (!info) return

  const payload: Record<string, unknown> = {
    type: "sandbox.push",
    idempotencyKey: `${ctx.sessionID}:${info.repo.owner}:${info.repo.name}:${info.head}:${info.commitSha}`,
    sessionId: ctx.sessionID,
    repo: info.repo,
    base: info.base,
    head: info.head,
    commitSha: info.commitSha,
    timestamp: new Date().toISOString(),
  }
  const accountID = process.env.OPENCODE_ACCOUNT_ID?.trim()
  const workspaceID = process.env.OPENCODE_WORKSPACE_ID?.trim()
  if (accountID) payload.accountID = accountID
  if (workspaceID) payload.workspaceID = workspaceID
  const githubToken = process.env.OPENCODE_GITHUB_TOKEN?.trim()
  if (githubToken) payload.githubToken = githubToken

  try {
    const response = await fetch(new URL("/sandbox/events", apiUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify(payload),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      log.warn("sandbox push event failed", { status: response.status, detail })
    }
  } catch (error) {
    log.warn("sandbox push event error", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

// TODO: we may wanna rename this tool so it works better on other shells
export const BashTool = Tool.define("bash", async () => {
  const shell = Shell.acceptable()
  log.info("bash tool using shell", { shell })

  return {
    description: DESCRIPTION.replaceAll("${directory}", Instance.directory)
      .replaceAll("${maxLines}", String(Truncate.MAX_LINES))
      .replaceAll("${maxBytes}", String(Truncate.MAX_BYTES)),
    parameters: z.object({
      command: z.string().describe("The command to execute"),
      timeout: z.number().describe("Optional timeout in milliseconds").optional(),
      workdir: z
        .string()
        .describe(
          `The working directory to run the command in. Defaults to ${Instance.directory}. Use this instead of 'cd' commands.`,
        )
        .optional(),
      description: z
        .string()
        .describe(
          "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
        ),
    }),
    async execute(params, ctx) {
      const cwd = params.workdir || Instance.directory
      if (params.timeout !== undefined && params.timeout < 0) {
        throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
      }
      const timeoutRaw = params.timeout ?? DEFAULT_TIMEOUT
      const timeout = Math.min(timeoutRaw, MAX_TIMEOUT)

      // Extra safety gate for potentially dangerous commands, even if bash is broadly allowed.
      const danger = BashSafety.reasons(params.command)
      if (danger.length > 0) {
        await ctx.ask({
          permission: "bash_dangerous",
          patterns: ["dangerous"],
          always: ["dangerous"],
          metadata: {
            reasons: danger,
            command: params.command,
            cwd,
          },
        })
      }
      const tree = await parser().then((p) => p.parse(params.command))
      if (!tree) {
        throw new Error("Failed to parse command")
      }
      const directories = new Set<string>()
      if (!Instance.containsPath(cwd)) directories.add(cwd)
      const patterns = new Set<string>()
      const always = new Set<string>()
      const networkHosts = new Set<string>()

      const gitSubcommand = (args: string[]) => {
        if (args[0] !== "git") return undefined
        const consumesValue = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"])
        for (let i = 1; i < args.length; i++) {
          const arg = args[i]
          if (arg === "--") {
            return args[i + 1]
          }
          if (arg.startsWith("-")) {
            if (consumesValue.has(arg) && i + 1 < args.length) {
              i++
            }
            continue
          }
          return arg
        }
        return undefined
      }

      let sawGitPush = false
      for (const node of tree.rootNode.descendantsOfType("command")) {
        if (!node) continue
        const command = []
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i)
          if (!child) continue
          if (
            child.type !== "command_name" &&
            child.type !== "word" &&
            child.type !== "string" &&
            child.type !== "raw_string" &&
            child.type !== "concatenation"
          ) {
            continue
          }
          command.push(child.text)
        }

        // Optional network egress gating (production hardening).
        // Extract likely hosts for common network tools and require an explicit "network" permission.
        if (Flag.OPENCODE_EXPERIMENTAL_NETWORK_GATING && command.length > 0) {
          for (const host of NetworkSafety.hostsFromArgs(command[0], command.slice(1))) {
            networkHosts.add(host)
          }
        }

        // not an exhaustive list, but covers most common cases
        if (["cd", "rm", "cp", "mv", "mkdir", "touch", "chmod", "chown"].includes(command[0])) {
          for (const arg of command.slice(1)) {
            if (arg.startsWith("-") || (command[0] === "chmod" && arg.startsWith("+"))) continue
            const resolved = await $`realpath ${arg}`
              .cwd(cwd)
              .quiet()
              .nothrow()
              .text()
              .then((x) => x.trim())
            log.info("resolved path", { arg, resolved })
            if (resolved) {
              // Git Bash on Windows returns Unix-style paths like /c/Users/...
              const normalized =
                process.platform === "win32" && resolved.match(/^\/[a-z]\//)
                  ? resolved.replace(/^\/([a-z])\//, (_, drive) => `${drive.toUpperCase()}:\\`).replace(/\//g, "\\")
                  : resolved
              if (!Instance.containsPath(normalized)) directories.add(normalized)
            }
          }
        }

        // cd covered by above check
        if (command.length && command[0] !== "cd") {
          patterns.add(command.join(" "))
          always.add(BashArity.prefix(command).join(" ") + "*")
        }

        if (command.length >= 2 && command[0] === "git" && gitSubcommand(command) === "push") {
          sawGitPush = true
        }
      }

      if (networkHosts.size > 0) {
        await ctx.ask({
          permission: "network",
          patterns: Array.from(networkHosts),
          always: Array.from(networkHosts),
          metadata: {
            tool: "bash",
            cwd,
          },
        })
      }

      if (directories.size > 0) {
        await ctx.ask({
          permission: "external_directory",
          patterns: Array.from(directories),
          always: Array.from(directories).map((x) => path.dirname(x) + "*"),
          metadata: {},
        })
      }

      if (patterns.size > 0) {
        await ctx.ask({
          permission: "bash",
          patterns: Array.from(patterns),
          always: Array.from(always),
          metadata: {},
        })
      }

      if (sawGitPush) {
        await configureGitHubAppPush(cwd)
      }

      const proc = spawn(params.command, {
        shell,
        cwd,
        env: {
          ...process.env,
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      })

      let output = ""

      // Initialize metadata with empty output
      ctx.metadata({
        metadata: {
          output: "",
          description: params.description,
        },
      })

      const append = (chunk: Buffer) => {
        output += chunk.toString()
        ctx.metadata({
          metadata: {
            // truncate the metadata to avoid GIANT blobs of data (has nothing to do w/ what agent can access)
            output: output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output,
            description: params.description,
          },
        })
      }

      proc.stdout?.on("data", append)
      proc.stderr?.on("data", append)

      let timedOut = false
      let aborted = false
      let exited = false

      const kill = () => Shell.killTree(proc, { exited: () => exited })

      if (ctx.abort.aborted) {
        aborted = true
        await kill()
      }

      const abortHandler = () => {
        aborted = true
        void kill()
      }

      ctx.abort.addEventListener("abort", abortHandler, { once: true })

      const timeoutTimer = setTimeout(() => {
        timedOut = true
        void kill()
      }, timeout + 100)

      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timeoutTimer)
          ctx.abort.removeEventListener("abort", abortHandler)
        }

        proc.once("exit", () => {
          exited = true
          cleanup()
          resolve()
        })

        proc.once("error", (error) => {
          exited = true
          cleanup()
          reject(error)
        })
      })

      const resultMetadata: string[] = []

      if (timedOut) {
        resultMetadata.push(`bash tool terminated command after exceeding timeout ${timeout} ms`)
      }

      if (aborted) {
        resultMetadata.push("User aborted the command")
      }

      if (resultMetadata.length > 0) {
        output += "\n\n<bash_metadata>\n" + resultMetadata.join("\n") + "\n</bash_metadata>"
      }

      if (sawGitPush && proc.exitCode === 0) {
        await reportSandboxPush(ctx, cwd)
      }

      return {
        title: params.description,
        metadata: {
          output: output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output,
          exit: proc.exitCode,
          description: params.description,
        },
        output,
      }
    },
  }
})
