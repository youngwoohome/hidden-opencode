import { describe, expect, test } from "bun:test"
import path from "path"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("session ui snapshot endpoints", () => {
  test("should store two HTML snapshots and return a diff", async () => {
    using upstream = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === "/v1") {
          return new Response("<html><body>Hello v1</body></html>", { headers: { "Content-Type": "text/html" } })
        }
        if (url.pathname === "/v2") {
          return new Response("<html><body>Hello v2</body></html>", { headers: { "Content-Type": "text/html" } })
        }
        return new Response("not found", { status: 404 })
      },
    })

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

        const s1Res = await app.request(`/session/${session.id}/ui/snapshot`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: new URL("/v1", upstream.url).toString() }),
        })
        expect(s1Res.status).toBe(200)
        const s1 = (await s1Res.json()) as { id: string; html: string }
        expect(s1.html).toContain("Hello v1")

        const s2Res = await app.request(`/session/${session.id}/ui/snapshot`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: new URL("/v2", upstream.url).toString() }),
        })
        expect(s2Res.status).toBe(200)
        const s2 = (await s2Res.json()) as { id: string; html: string }
        expect(s2.html).toContain("Hello v2")

        const cmpRes = await app.request(`/session/${session.id}/ui/snapshot/compare`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ beforeID: s1.id, afterID: s2.id }),
        })
        expect(cmpRes.status).toBe(200)
        const cmp = (await cmpRes.json()) as { changed: boolean; additions: number; deletions: number; diff: string }
        expect(cmp.changed).toBe(true)
        expect(cmp.additions).toBeGreaterThan(0)
        expect(cmp.deletions).toBeGreaterThan(0)
        expect(cmp.diff).toContain("Hello v1")
        expect(cmp.diff).toContain("Hello v2")

        // cleanup
        const deleteRes = await app.request(`/session/${session.id}`, { method: "DELETE" })
        expect(deleteRes.status).toBe(200)
      },
    })
  })
})

