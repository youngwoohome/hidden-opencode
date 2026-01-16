import { Hono } from "hono"
import { SandboxProviders } from "./index"

type SandboxCreateRequest = {
  provider?: string
  repo?: { url: string; ref: string }
  resources?: { cpu?: number; memoryMB?: number; diskGB?: number }
  ttl?: { ttlSeconds?: number; idleSeconds?: number }
  env?: Record<string, string>
  name?: string
}

type SandboxStopRequest = {
  provider?: string
  id?: string
}

const app = new Hono()

app.get("/health", (c) => c.json({ ok: true }))

function parsePassthroughEnv() {
  const raw = process.env.SANDBOX_PASSTHROUGH_ENV ?? ""
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
}

function loadDefaultEnv() {
  const out: Record<string, string> = {}
  const allowlist = parsePassthroughEnv()
  for (const key of allowlist) {
    const value = process.env[key]
    if (value) out[key] = value
  }
  const json = process.env.SANDBOX_DEFAULT_ENV_JSON
  if (json) {
    try {
      const parsed = JSON.parse(json)
      if (parsed && typeof parsed === "object") {
        Object.assign(out, parsed)
      }
    } catch (error) {
      console.warn("Failed to parse SANDBOX_DEFAULT_ENV_JSON", error)
    }
  }
  return out
}

app.post("/sandbox/create", async (c) => {
  const body = (await c.req.json()) as SandboxCreateRequest
  if (!body?.repo?.url || !body?.repo?.ref) {
    return c.json({ error: "repo.url and repo.ref are required" }, { status: 400 })
  }

  const defaultEnv = loadDefaultEnv()
  const mergedEnv = { ...defaultEnv, ...(body.env ?? {}) }
  const provider = SandboxProviders.resolve(body.provider)
  const handle = await provider.create({
    provider: body.provider,
    repo: body.repo,
    resources: body.resources,
    ttl: body.ttl,
    env: mergedEnv,
    name: body.name,
  })

  return c.json(handle)
})

app.post("/sandbox/stop", async (c) => {
  const body = (await c.req.json()) as SandboxStopRequest
  if (!body?.id) {
    return c.json({ error: "id is required" }, { status: 400 })
  }

  const provider = SandboxProviders.resolve(body.provider)
  await provider.stop(body.id)
  return c.json({ ok: true })
})

const port = Number(process.env.SANDBOX_CONTROLLER_PORT ?? "8787")
const server = Bun.serve({
  port,
  fetch: app.fetch,
})

console.log(`sandbox controller listening on http://0.0.0.0:${server.port}`)
