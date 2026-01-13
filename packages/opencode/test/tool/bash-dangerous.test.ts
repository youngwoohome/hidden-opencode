import { describe, expect, test } from "bun:test"
import { BashTool } from "../../src/tool/bash"
import { Instance } from "../../src/project/instance"
import type { Tool } from "../../src/tool/tool"
import { PermissionNext } from "../../src/permission/next"

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: "ses_test",
  messageID: "msg_test",
  callID: "call_test",
  agent: "build",
  abort: AbortSignal.any([]),
  metadata: () => {},
}

describe("bash tool safety gate", () => {
  test("requests bash_dangerous permission for dangerous commands", async () => {
    const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
    const ctx: Tool.Context = {
      ...baseCtx,
      ask: async (req) => {
        requests.push(req)
        // Simulate user rejecting so we don't execute the command.
        throw new PermissionNext.RejectedError()
      },
    }

    await Instance.provide({
      directory: "/tmp",
      fn: async () => {
        const bash = await BashTool.init()
        await expect(
          bash.execute(
            {
              command: "rm -rf /",
              description: "Delete everything",
            },
            ctx,
          ),
        ).rejects.toBeInstanceOf(PermissionNext.RejectedError)
      },
    })

    expect(requests.some((r) => r.permission === "bash_dangerous")).toBe(true)
  })
})

