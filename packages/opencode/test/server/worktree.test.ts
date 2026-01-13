import { describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"

describe("experimental.worktree endpoints", () => {
  test("should create, list, and remove a worktree (sandbox) for a git project", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.App()

    const directoryQuery = `?directory=${encodeURIComponent(tmp.path)}`

    // #when: create worktree
    const createRes = await app.request(`/experimental/worktree${directoryQuery}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "inspect-smoke-worktree" }),
    })
    expect(createRes.status).toBe(200)
    const created = (await createRes.json()) as { name: string; branch: string; directory: string }
    expect(created.name).toBeTruthy()
    expect(created.branch).toStartWith("opencode/")
    expect(created.directory).toContain(created.name)

    // #then: list should include created directory (create registers sandbox)
    const listRes1 = await app.request(`/experimental/worktree${directoryQuery}`, { method: "GET" })
    expect(listRes1.status).toBe(200)
    const sandboxes1 = (await listRes1.json()) as string[]
    expect(sandboxes1).toContain(created.directory)

    // #when: remove worktree
    const removeRes = await app.request(`/experimental/worktree${directoryQuery}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directory: created.directory, branch: created.branch }),
    })
    expect(removeRes.status).toBe(200)
    expect(await removeRes.json()).toBe(true)

    // #then: list should no longer include it
    const listRes2 = await app.request(`/experimental/worktree${directoryQuery}`, { method: "GET" })
    expect(listRes2.status).toBe(200)
    const sandboxes2 = (await listRes2.json()) as string[]
    expect(sandboxes2).not.toContain(created.directory)
  })
})

