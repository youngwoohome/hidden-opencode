import { Bus } from "@/bus"
import { MessageV2 } from "@/session/message-v2"
import { Storage } from "@/storage/storage"
import { Instance } from "@/project/instance"
import z from "zod"

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

  export const Event = z.discriminatedUnion("type", [ToolEvent]).meta({ ref: "SessionEvent" })
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

  export async function list(input: { sessionID: string; limit?: number }) {
    const items = await Storage.list(["event", input.sessionID])
    const events = await Promise.all(items.map((key) => Storage.read<Event>(key)))
    events.sort((a, b) => a.time.created - b.time.created)
    if (input.limit !== undefined) return events.slice(-input.limit)
    return events
  }
}

