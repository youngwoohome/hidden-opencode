import { describe, expect, test } from "bun:test"
import path from "path"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("session events endpoint", () => {
  test("should persist tool events and allow session-level query", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()

        // create session
        const createRes = await app.request("/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })
        expect(createRes.status).toBe(200)
        const session = (await createRes.json()) as { id: string }

        // run a shell command (records a bash tool part)
        const cmd = `echo "inspect-event"`
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

        // query events
        const eventsRes = await app.request(`/session/${session.id}/event`, { method: "GET" })
        expect(eventsRes.status).toBe(200)
        const events = (await eventsRes.json()) as Array<{
          type: string
          tool?: string
          status?: string
          output?: string
          sessionID?: string
        }>

        const completedBash = events.find((e) => e.type === "tool" && e.tool === "bash" && e.status === "completed")
        expect(completedBash).toBeTruthy()
        expect(completedBash?.sessionID).toBe(session.id)
        expect(completedBash?.output ?? "").toContain("inspect-event")

        // cleanup
        const deleteRes = await app.request(`/session/${session.id}`, { method: "DELETE" })
        expect(deleteRes.status).toBe(200)
      },
    })
  })
})

