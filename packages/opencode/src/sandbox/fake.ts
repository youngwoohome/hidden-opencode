import { NamedError } from "@opencode-ai/util/error"
import z from "zod"
import { Sandbox } from "./types"

export namespace SandboxFake {
  export const NotImplemented = NamedError.create(
    "SandboxNotImplemented",
    z.object({
      message: z.string(),
    }),
  )

  export function provider(): Sandbox.Provider {
    const store = new Map<string, Sandbox.Handle>()
    return {
      id: "fake",
      async create(input) {
        const created = Date.now()
        const ttlSeconds = input.ttl?.ttlSeconds
        const expires = ttlSeconds ? created + ttlSeconds * 1000 : undefined
        const id = `sbx_fake_${Math.random().toString(16).slice(2)}`
        const handle: Sandbox.Handle = {
          id,
          provider: "fake",
          url: input.env?.OPENCODE_SANDBOX_URL, // allow deterministic tests if desired
          repo: input.repo,
          resources: input.resources,
          ttl: input.ttl,
          time: { created, expires },
          metadata: { name: input.name },
        }
        store.set(id, handle)
        return handle
      },
      async get(id) {
        return store.get(id)
      },
      async stop(id) {
        store.delete(id)
      },
      async snapshot() {
        throw new NotImplemented({ message: "fake provider does not support snapshot" })
      },
      async restore() {
        throw new NotImplemented({ message: "fake provider does not support restore" })
      },
    }
  }
}

