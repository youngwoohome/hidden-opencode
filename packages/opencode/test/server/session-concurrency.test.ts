import { describe, expect, test } from "bun:test"
import path from "path"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("session concurrency limits", () => {
  test("project-level active session limit (OPENCODE_SESSION_CONCURRENCY_MAX)", async () => {
    const prev = process.env.OPENCODE_SESSION_CONCURRENCY_MAX
    process.env.OPENCODE_SESSION_CONCURRENCY_MAX = "1"
    process.env.OPENCODE_USER_SESSION_CONCURRENCY_MAX = ""
    try {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const app = Server.App()

          const s1 = await app.request("/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          })
          expect(s1.status).toBe(200)
          const a = (await s1.json()) as { id: string }

          const s2 = await app.request("/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          })
          expect(s2.status).toBe(200)
          const b = (await s2.json()) as { id: string }

          // Start a long-ish run on session A.
          const long = app.request(`/session/${a.id}/shell`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agent: "build",
              model: { providerID: "test", modelID: "test" },
              command: `sleep 2 && echo "a-done"`,
            }),
          })

          // While A is active, starting B should be rejected (429).
          await Bun.sleep(100)
          const short = await app.request(`/session/${b.id}/shell`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agent: "build",
              model: { providerID: "test", modelID: "test" },
              command: `echo "b"`,
            }),
          })
          expect(short.status).toBe(429)

          // Wait for A to finish to avoid leaking running state into other tests.
          const longRes = await long
          expect(longRes.status).toBe(200)
        },
      })
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_SESSION_CONCURRENCY_MAX
      else process.env.OPENCODE_SESSION_CONCURRENCY_MAX = prev
      delete process.env.OPENCODE_USER_SESSION_CONCURRENCY_MAX
    }
  })

  test("user-level active session limit (OPENCODE_USER_SESSION_CONCURRENCY_MAX + x-opencode-user)", async () => {
    const prev = process.env.OPENCODE_USER_SESSION_CONCURRENCY_MAX
    process.env.OPENCODE_SESSION_CONCURRENCY_MAX = ""
    process.env.OPENCODE_USER_SESSION_CONCURRENCY_MAX = "1"
    try {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const app = Server.App()

          const s1 = await app.request("/session", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-opencode-user": "alice" },
            body: JSON.stringify({}),
          })
          expect(s1.status).toBe(200)
          const a = (await s1.json()) as { id: string }

          const s2 = await app.request("/session", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-opencode-user": "alice" },
            body: JSON.stringify({}),
          })
          expect(s2.status).toBe(200)
          const b = (await s2.json()) as { id: string }

          const s3 = await app.request("/session", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-opencode-user": "bob" },
            body: JSON.stringify({}),
          })
          expect(s3.status).toBe(200)
          const c = (await s3.json()) as { id: string }

          const long = app.request(`/session/${a.id}/shell`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agent: "build",
              model: { providerID: "test", modelID: "test" },
              command: `sleep 2 && echo "a-done"`,
            }),
          })

          await Bun.sleep(100)

          // Same user (alice) should be rejected while one of alice's sessions is active.
          const sameUser = await app.request(`/session/${b.id}/shell`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agent: "build",
              model: { providerID: "test", modelID: "test" },
              command: `echo "b"`,
            }),
          })
          expect(sameUser.status).toBe(429)

          // Different user (bob) should still be allowed.
          const otherUser = await app.request(`/session/${c.id}/shell`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agent: "build",
              model: { providerID: "test", modelID: "test" },
              command: `echo "c"`,
            }),
          })
          expect(otherUser.status).toBe(200)

          const longRes = await long
          expect(longRes.status).toBe(200)
        },
      })
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_USER_SESSION_CONCURRENCY_MAX
      else process.env.OPENCODE_USER_SESSION_CONCURRENCY_MAX = prev
      delete process.env.OPENCODE_SESSION_CONCURRENCY_MAX
    }
  })
})

