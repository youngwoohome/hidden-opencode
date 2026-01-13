import { describe, expect, test } from "bun:test"
import path from "path"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("session smoke (create -> shell tool -> messages)", () => {
  test("should create a session, run a shell command, and persist resulting messages", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()

        // #when: create session via API
        const createRes = await app.request("/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })
        expect(createRes.status).toBe(200)
        const session = (await createRes.json()) as { id: string }
        expect(session.id).toStartWith("ses_")

        // #when: run a command via the "shell" endpoint (executes bash tool without LLM calls)
        const cmd = `echo "inspect-smoke"`
        const shellRes = await app.request(`/session/${session.id}/shell`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "test", modelID: "test" },
            command: cmd,
          }),
        })
        expect(shellRes.status).toBe(200)
        const shellMsg = (await shellRes.json()) as {
          info: { id: string; sessionID: string; role: string }
          parts: Array<{ type: string; tool?: string; state?: { status?: string; output?: string } }>
        }
        expect(shellMsg.info.sessionID).toBe(session.id)
        expect(shellMsg.info.role).toBe("assistant")
        expect(shellMsg.parts[0]?.type).toBe("tool")
        expect(shellMsg.parts[0]?.tool).toBe("bash")
        expect(shellMsg.parts[0]?.state?.status).toBe("completed")
        expect(shellMsg.parts[0]?.state?.output ?? "").toContain("inspect-smoke")

        // #then: messages endpoint should include the new messages/parts
        const messagesRes = await app.request(`/session/${session.id}/message?limit=20`, { method: "GET" })
        expect(messagesRes.status).toBe(200)
        const messages = (await messagesRes.json()) as Array<{
          info: { id: string; role: string }
          parts: Array<{ type: string; tool?: string }>
        }>
        expect(messages.length).toBeGreaterThanOrEqual(2) // user + assistant
        expect(messages.some((m) => m.parts.some((p) => p.type === "tool" && p.tool === "bash"))).toBe(true)

        // cleanup
        const deleteRes = await app.request(`/session/${session.id}`, { method: "DELETE" })
        expect(deleteRes.status).toBe(200)
      },
    })
  })
})

