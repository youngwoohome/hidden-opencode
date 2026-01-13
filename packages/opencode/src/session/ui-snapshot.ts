import { Storage } from "@/storage/storage"
import z from "zod"
import { ulid } from "ulid"
import { structuredPatch, formatPatch } from "diff"
import { fn } from "@/util/fn"

function truncateText(input: string, max = 512_000) {
  if (input.length <= max) return { text: input, truncated: false as const, originalLength: input.length }
  return {
    text: input.slice(0, max) + "\n...[truncated]",
    truncated: true as const,
    originalLength: input.length,
  }
}

export namespace SessionUISnapshot {
  export const Snapshot = z
    .object({
      id: z.string(),
      sessionID: z.string(),
      url: z.string(),
      time: z.object({
        created: z.number(),
      }),
      html: z.string(),
      htmlTruncated: z.boolean(),
      htmlLength: z.number(),
    })
    .meta({ ref: "SessionUISnapshot" })
  export type Snapshot = z.infer<typeof Snapshot>

  export const CreateInput = z.object({
    sessionID: z.string(),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
    maxHtml: z.number().int().min(1_000).max(2_000_000).optional(),
  })
  export type CreateInput = z.infer<typeof CreateInput>

  export const create = fn(CreateInput, async (input) => {
    const res = await fetch(input.url, {
      headers: input.headers,
    })
    const htmlRaw = await res.text()
    const max = input.maxHtml ?? 512_000
    const info = truncateText(htmlRaw, max)

    const snapshot: Snapshot = {
      id: ulid(),
      sessionID: input.sessionID,
      url: input.url,
      time: { created: Date.now() },
      html: info.text,
      htmlTruncated: info.truncated,
      htmlLength: info.originalLength,
    }

    await Storage.write(["ui_snapshot", input.sessionID, snapshot.id], snapshot)
    return snapshot
  })

  export const CompareInput = z.object({
    sessionID: z.string(),
    beforeID: z.string(),
    afterID: z.string(),
    context: z.number().int().min(0).max(20).optional().default(3),
  })
  export type CompareInput = z.infer<typeof CompareInput>

  export const CompareOutput = z
    .object({
      changed: z.boolean(),
      additions: z.number(),
      deletions: z.number(),
      diff: z.string(),
    })
    .meta({ ref: "SessionUISnapshotCompare" })
  export type CompareOutput = z.infer<typeof CompareOutput>

  export const compare = fn(CompareInput, async (input): Promise<CompareOutput> => {
    const before = await Storage.read<Snapshot>(["ui_snapshot", input.sessionID, input.beforeID])
    const after = await Storage.read<Snapshot>(["ui_snapshot", input.sessionID, input.afterID])

    if (before.html === after.html) {
      return { changed: false, additions: 0, deletions: 0, diff: "" }
    }

    const patch = structuredPatch(
      input.beforeID,
      input.afterID,
      before.html,
      after.html,
      "before",
      "after",
      { context: input.context },
    )
    const diff = formatPatch(patch)

    let additions = 0
    let deletions = 0
    for (const hunk of patch.hunks ?? []) {
      for (const line of hunk.lines ?? []) {
        if (line.startsWith("+") && !line.startsWith("+++")) additions++
        else if (line.startsWith("-") && !line.startsWith("---")) deletions++
      }
    }

    return { changed: true, additions, deletions, diff }
  })
}

