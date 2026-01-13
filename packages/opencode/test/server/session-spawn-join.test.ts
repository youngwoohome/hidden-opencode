import { describe, expect, test } from "bun:test"
import path from "path"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("session spawn/join endpoints", () => {
  test("should spawn a child session, run a tool in child, join into parent (text + event)", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()

        // create parent session
        const createRes = await app.request("/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })
        expect(createRes.status).toBe(200)
        const parent = (await createRes.json()) as { id: string }

        // spawn child
        const spawnRes = await app.request(`/session/${parent.id}/spawn`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "child-task" }),
        })
        expect(spawnRes.status).toBe(200)
        const child = (await spawnRes.json()) as { id: string; parentID?: string; title?: string }
        expect(child.id).toStartWith("ses_")
        expect(child.title).toBe("child-task")

        // run a shell command inside child (creates tool part + tool event in child log)
        const cmd = `echo "spawn-join"`
        const shellRes = await app.request(`/session/${child.id}/shell`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "test", modelID: "test" },
            command: cmd,
          }),
        })
        expect(shellRes.status).toBe(200)

        // join child into parent
        const joinRes = await app.request(`/session/${parent.id}/join`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ childSessionID: child.id }),
        })
        expect(joinRes.status).toBe(200)
        const join = (await joinRes.json()) as { ok: true; summary: string; childSessionID: string }
        expect(join.ok).toBe(true)
        expect(join.childSessionID).toBe(child.id)
        expect(join.summary).toContain(child.id)
        expect(join.summary).toContain("spawn-join")

        // parent messages include synthetic summary text
        const msgsRes = await app.request(`/session/${parent.id}/message?limit=50`, { method: "GET" })
        expect(msgsRes.status).toBe(200)
        const msgs = (await msgsRes.json()) as Array<{ parts: Array<{ type: string; text?: string; synthetic?: boolean }> }>
        const hasJoinSummary = msgs.some((m) => m.parts.some((p) => p.type === "text" && (p.text ?? "").includes(child.id)))
        expect(hasJoinSummary).toBe(true)

        // parent event log contains spawn + join events
        const eventsRes = await app.request(`/session/${parent.id}/event`, { method: "GET" })
        expect(eventsRes.status).toBe(200)
        const events = (await eventsRes.json()) as Array<{ type: string; childSessionID?: string }>
        expect(events.some((e) => e.type === "spawn" && e.childSessionID === child.id)).toBe(true)
        expect(events.some((e) => e.type === "join" && e.childSessionID === child.id)).toBe(true)

        // cleanup (deletes children recursively)
        const delRes = await app.request(`/session/${parent.id}`, { method: "DELETE" })
        expect(delRes.status).toBe(200)
      },
    })
  })
})

