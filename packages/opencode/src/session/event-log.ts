import { Bus } from "@/bus"
import { MessageV2 } from "@/session/message-v2"
import { Storage } from "@/storage/storage"
import { Instance } from "@/project/instance"
import { PermissionNext } from "@/permission/next"
import z from "zod"
import { ulid } from "ulid"

function truncateText(input: string, max = 64_000) {
  if (input.length <= max) return { text: input, truncated: false as const, originalLength: input.length }
  return {
    text: input.slice(0, max) + "\n...[truncated]",
    truncated: true as const,
    originalLength: input.length,
  }
}

export namespace SessionEventLog {
  export const ToolStatus = z.enum(["running", "completed", "error"])

  export const ToolEvent = z
    .object({
      type: z.literal("tool"),
      id: z.string(),
      sessionID: z.string(),
      messageID: z.string(),
      partID: z.string(),
      callID: z.string(),
      tool: z.string(),
      status: ToolStatus,
      time: z.object({
        created: z.number(),
        start: z.number().optional(),
        end: z.number().optional(),
      }),
      title: z.string().optional(),
      input: z.record(z.string(), z.any()).optional(),
      output: z.string().optional(),
      outputTruncated: z.boolean().optional(),
      outputLength: z.number().optional(),
      error: z.string().optional(),
      metadata: z.record(z.string(), z.any()).optional(),
      attachments: z.array(z.any()).optional(),
    })
    .meta({ ref: "SessionToolEvent" })

  export const PermissionAskedEvent = z
    .object({
      type: z.literal("permission_asked"),
      id: z.string(),
      sessionID: z.string(),
      time: z.object({
        created: z.number(),
      }),
      request: PermissionNext.Request,
    })
    .meta({ ref: "SessionPermissionAskedEvent" })

  export const PermissionRepliedEvent = z
    .object({
      type: z.literal("permission_replied"),
      id: z.string(),
      sessionID: z.string(),
      time: z.object({
        created: z.number(),
      }),
      requestID: z.string(),
      reply: PermissionNext.Reply,
    })
    .meta({ ref: "SessionPermissionRepliedEvent" })

  export const SyncWaitEvent = z
    .object({
      type: z.literal("sync_wait"),
      id: z.string(),
      sessionID: z.string(),
      time: z.object({
        created: z.number(),
        start: z.number(),
        end: z.number(),
      }),
      tool: z.string(),
      lockPath: z.string(),
      waitedMs: z.number(),
      timedOut: z.boolean().optional(),
    })
    .meta({ ref: "SessionSyncWaitEvent" })

  export const SpawnEvent = z
    .object({
      type: z.literal("spawn"),
      id: z.string(),
      sessionID: z.string(),
      childSessionID: z.string(),
      time: z.object({
        created: z.number(),
      }),
      title: z.string().optional(),
      directory: z.string().optional(),
    })
    .meta({ ref: "SessionSpawnEvent" })

  export const JoinEvent = z
    .object({
      type: z.literal("join"),
      id: z.string(),
      sessionID: z.string(),
      childSessionID: z.string(),
      time: z.object({
        created: z.number(),
      }),
      summary: z.string(),
      summaryTruncated: z.boolean().optional(),
      summaryLength: z.number().optional(),
    })
    .meta({ ref: "SessionJoinEvent" })

  export const Event = z
    .discriminatedUnion("type", [ToolEvent, PermissionAskedEvent, PermissionRepliedEvent, SyncWaitEvent, SpawnEvent, JoinEvent])
    .meta({ ref: "SessionEvent" })
  export type Event = z.infer<typeof Event>

  // Instance-scoped state (Bus is instance-scoped as well).
  const state = Instance.state(() => ({
    initialized: false,
    seenRunning: new Set<string>(), // partID
  }))

  export function init() {
    const s = state()
    if (s.initialized) return
    s.initialized = true

    Bus.subscribe(PermissionNext.Event.Asked, async (evt) => {
      const req = evt.properties
      const created = Date.now()
      const eventID = `permission-asked-${req.id}`
      const event: z.infer<typeof PermissionAskedEvent> = {
        type: "permission_asked",
        id: eventID,
        sessionID: req.sessionID,
        time: { created },
        request: req,
      }
      await Storage.write(["event", req.sessionID, eventID], event)
    })

    Bus.subscribe(PermissionNext.Event.Replied, async (evt) => {
      const rep = evt.properties
      const created = Date.now()
      const eventID = `permission-replied-${rep.requestID}-${created}`
      const event: z.infer<typeof PermissionRepliedEvent> = {
        type: "permission_replied",
        id: eventID,
        sessionID: rep.sessionID,
        time: { created },
        requestID: rep.requestID,
        reply: rep.reply,
      }
      await Storage.write(["event", rep.sessionID, eventID], event)
    })

    Bus.subscribe(MessageV2.Event.PartUpdated, async (evt) => {
      const part = evt.properties.part
      if (part.type !== "tool") return

      const status = part.state.status
      if (status === "pending") return

      if (status === "running") {
        if (s.seenRunning.has(part.id)) return
        s.seenRunning.add(part.id)
      }

      const eventID = `${part.id}-${status}`
      const created = Date.now()

      const output =
        status === "completed" && typeof (part.state as any).output === "string" ? ((part.state as any).output as string) : ""
      const outputInfo = output ? truncateText(output) : undefined

      const errorText = status === "error" ? String((part.state as any).error ?? "") : ""

      const event: z.infer<typeof ToolEvent> = {
        type: "tool",
        id: eventID,
        sessionID: part.sessionID,
        messageID: part.messageID,
        partID: part.id,
        callID: part.callID,
        tool: part.tool,
        status,
        time: {
          created,
          start: (part.state as any).time?.start,
          end: (part.state as any).time?.end,
        },
        title: (part.state as any).title,
        input: (part.state as any).input,
        ...(outputInfo && {
          output: outputInfo.text,
          outputTruncated: outputInfo.truncated,
          outputLength: outputInfo.originalLength,
        }),
        ...(errorText && { error: truncateText(errorText, 16_000).text }),
        metadata: (part.state as any).metadata,
        attachments: status === "completed" ? (part.state as any).attachments : undefined,
      }

      await Storage.write(["event", part.sessionID, eventID], event)
    })
  }

  export async function write(event: Event) {
    await Storage.write(["event", event.sessionID, event.id], event)
  }

  export async function syncWait(input: {
    sessionID: string
    tool: string
    lockPath: string
    start: number
    end: number
    timedOut?: boolean
  }) {
    const created = Date.now()
    const event: z.infer<typeof SyncWaitEvent> = {
      type: "sync_wait",
      id: "syncwait-" + ulid(),
      sessionID: input.sessionID,
      time: { created, start: input.start, end: input.end },
      tool: input.tool,
      lockPath: input.lockPath,
      waitedMs: Math.max(0, input.end - input.start),
      timedOut: input.timedOut,
    }
    await write(event)
    return event
  }

  export async function spawn(input: { sessionID: string; childSessionID: string; title?: string; directory?: string }) {
    const created = Date.now()
    const event: z.infer<typeof SpawnEvent> = {
      type: "spawn",
      id: "spawn-" + ulid(),
      sessionID: input.sessionID,
      childSessionID: input.childSessionID,
      time: { created },
      title: input.title,
      directory: input.directory,
    }
    await write(event)
    return event
  }

  export async function join(input: { sessionID: string; childSessionID: string; summary: string }) {
    const created = Date.now()
    const info = truncateText(input.summary, 64_000)
    const event: z.infer<typeof JoinEvent> = {
      type: "join",
      id: "join-" + ulid(),
      sessionID: input.sessionID,
      childSessionID: input.childSessionID,
      time: { created },
      summary: info.text,
      summaryTruncated: info.truncated,
      summaryLength: info.originalLength,
    }
    await write(event)
    return event
  }

  export async function list(input: { sessionID: string; limit?: number }) {
    const items = await Storage.list(["event", input.sessionID])
    const events = await Promise.all(items.map((key) => Storage.read<Event>(key)))
    events.sort((a, b) => a.time.created - b.time.created)
    if (input.limit !== undefined) return events.slice(-input.limit)
    return events
  }
}

