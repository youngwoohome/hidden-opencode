import { describe, expect, test } from "bun:test"
import { SandboxProviders } from "../../src/sandbox"
import { Sandbox } from "../../src/sandbox/types"

describe("sandbox providers", () => {
  test("fake provider create returns a valid handle", async () => {
    const p = SandboxProviders.resolve("fake")
    const handle = await p.create({
      provider: "fake",
      name: "test",
      repo: { url: "https://example.com/repo.git", ref: "deadbeef" },
      ttl: { ttlSeconds: 10 },
      resources: { cpu: 1, memoryMB: 256 },
      env: { OPENCODE_SYNC_GATING: "true" },
    })
    expect(handle.provider).toBe("fake")
    expect(handle.id).toContain("sbx_fake_")
    Sandbox.Handle.parse(handle)
  })
})

