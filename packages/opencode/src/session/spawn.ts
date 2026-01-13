import z from "zod"
import { fn } from "@/util/fn"
import { Session } from "@/session"
import { Identifier } from "@/id/id"
import { MessageV2 } from "@/session/message-v2"
import { Instance } from "@/project/instance"
import { SessionEventLog } from "@/session/event-log"

function formatChildSummary(input: {
  child: Session.Info
  messages: MessageV2.WithParts[]
}) {
  const lastAssistantText =
    input.messages
      .filter((m) => m.info.role === "assistant")
      .flatMap((m) => m.parts)
      .filter((p): p is MessageV2.TextPart => p.type === "text")
      .at(-1)?.text ?? ""

  const toolParts = input.messages.flatMap((m) => m.parts).filter((p) => p.type === "tool") as MessageV2.ToolPart[]
  const completed = toolParts.filter((p) => p.state.status === "completed").length
  const errored = toolParts.filter((p) => p.state.status === "error").length

  const lines = [
    `Joined child session: ${input.child.id}`,
    input.child.title ? `Title: ${input.child.title}` : undefined,
    `Directory: ${input.child.directory}`,
    `Tools: ${toolParts.length} (completed ${completed}, error ${errored})`,
    lastAssistantText ? `Last assistant text:\n${lastAssistantText}` : undefined,
  ].filter(Boolean) as string[]

  return lines.join("\n\n")
}

export namespace SessionSpawn {
  export const SpawnInput = z.object({
    parentSessionID: Identifier.schema("session"),
    title: z.string().optional(),
    directory: z.string().optional(),
  })
  export type SpawnInput = z.infer<typeof SpawnInput>

  export const spawn = fn(SpawnInput, async (input) => {
    const parent = await Session.get(input.parentSessionID)

    // Default to current instance directory (project root in most cases).
    const directory = input.directory ?? Instance.directory

    const child = await Session.createNext({
      parentID: parent.id,
      directory,
      title: input.title,
    })

    await SessionEventLog.spawn({
      sessionID: parent.id,
      childSessionID: child.id,
      title: child.title,
      directory: child.directory,
    })

    return child
  })

  export const JoinInput = z.object({
    parentSessionID: Identifier.schema("session"),
    childSessionID: Identifier.schema("session"),
  })
  export type JoinInput = z.infer<typeof JoinInput>

  export const join = fn(JoinInput, async (input) => {
    const parent = await Session.get(input.parentSessionID)
    const child = await Session.get(input.childSessionID)
    const messages = await Session.messages({ sessionID: child.id })

    const summary = formatChildSummary({ child, messages })

    // Write a synthetic user+assistant message pair into the parent session so it is visible in the main timeline.
    const now = Date.now()
    const userMsg: MessageV2.User = {
      id: Identifier.ascending("message"),
      sessionID: parent.id,
      time: { created: now },
      role: "user",
      agent: "build",
      model: { providerID: "test", modelID: "test" },
      system: "synthetic: join child session",
    }
    await Session.updateMessage(userMsg)
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: userMsg.id,
      sessionID: parent.id,
      type: "text",
      text: `Join child session ${child.id}`,
      synthetic: true,
      time: { start: now, end: now },
    })

    const assistantMsg: MessageV2.Assistant = {
      id: Identifier.ascending("message"),
      sessionID: parent.id,
      parentID: userMsg.id,
      role: "assistant",
      mode: "build",
      agent: "build",
      cost: 0,
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      time: { created: Date.now(), completed: Date.now() },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test",
      providerID: "test",
      finish: "stop",
    }
    await Session.updateMessage(assistantMsg)
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: assistantMsg.id,
      sessionID: parent.id,
      type: "text",
      text: summary,
      synthetic: true,
      time: { start: Date.now(), end: Date.now() },
      metadata: {
        childSessionID: child.id,
      },
    })

    await SessionEventLog.join({
      sessionID: parent.id,
      childSessionID: child.id,
      summary,
    })

    return {
      ok: true as const,
      summary,
      messageID: assistantMsg.id,
      childSessionID: child.id,
    }
  })
}

