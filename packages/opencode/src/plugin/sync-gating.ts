import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import fs from "fs/promises"
import path from "path"
import { SessionEventLog } from "@/session/event-log"

const WRITE_TOOLS = new Set(["edit", "write", "patch", "multiedit"])

async function exists(p: string) {
  return fs
    .stat(p)
    .then(() => true)
    .catch(() => false)
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms))
}

/**
 * Production-style safety: when repo sync is in progress, allow reads but block writes.
 *
 * Enable by creating `.opencode/sync.pending` in the session directory (or worktree),
 * and setting `OPENCODE_SYNC_GATING=true`.
 *
 * The orchestrator (e.g. remote sandbox bootstrap) is expected to remove the lock file
 * once git sync is finished.
 */
export async function SyncGatingPlugin(input: PluginInput): Promise<Hooks> {
  const enabled = process.env["OPENCODE_SYNC_GATING"] === "true"
  if (!enabled) return {}

  // Prefer per-session directory, fall back to worktree.
  const lockPath = path.join(input.directory, ".opencode", "sync.pending")
  const lockPathFallback = path.join(input.worktree, ".opencode", "sync.pending")

  const pollMs = Number(process.env["OPENCODE_SYNC_GATING_POLL_MS"] ?? "250")
  const timeoutMs = Number(process.env["OPENCODE_SYNC_GATING_TIMEOUT_MS"] ?? "60000")

  return {
    async "tool.execute.before"(evt) {
      if (!WRITE_TOOLS.has(evt.tool)) return

      const activeLock = (await exists(lockPath)) ? lockPath : (await exists(lockPathFallback)) ? lockPathFallback : null
      if (!activeLock) return

      const start = Date.now()
      while (Date.now() - start < timeoutMs) {
        if (!(await exists(activeLock))) {
          await SessionEventLog.syncWait({
            sessionID: evt.sessionID,
            tool: evt.tool,
            lockPath: activeLock,
            start,
            end: Date.now(),
          })
          return
        }
        await sleep(pollMs)
      }

      await SessionEventLog.syncWait({
        sessionID: evt.sessionID,
        tool: evt.tool,
        lockPath: activeLock,
        start,
        end: Date.now(),
        timedOut: true,
      })

      throw new Error(
        `Repository sync is still in progress (lock: ${activeLock}). Refusing to run ${evt.tool} until sync completes.`,
      )
    },
  }
}

