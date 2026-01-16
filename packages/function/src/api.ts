import { Hono } from "hono"
import { DurableObject } from "cloudflare:workers"
import { randomUUID } from "node:crypto"
import { jwtVerify, createRemoteJWKSet } from "jose"
import { createAppAuth } from "@octokit/auth-app"
import { Octokit } from "@octokit/rest"
import { Resource } from "sst"
import { cors } from "hono/cors"

type Env = {
  SYNC_SERVER?: DurableObjectNamespace<SyncServer>
  SESSION_REGISTRY?: DurableObjectNamespace<SessionRegistry>
  Bucket: R2Bucket
  WEB_DOMAIN: string
  SANDBOX_CONTROLLER_URL?: string
  CONSOLE_URL?: string
  GITHUB_WEBHOOK_SECRET?: string
}

type SandboxHandle = {
  id: string
  provider: string
  url?: string
  repo?: { url: string; ref: string }
  resources?: { cpu?: number; memoryMB?: number; diskGB?: number }
  ttl?: { ttlSeconds?: number; idleSeconds?: number }
  time: { created: number; expires?: number }
  metadata?: Record<string, any>
}

type SessionInfo = {
  id: string
  repo: { url: string; ref: string }
  sandbox: SandboxHandle
  opencode: { sessionID: string }
  model?: { providerID: string; modelID: string }
  worktree?: string
  title?: string
  accountID?: string
  workspaceID?: string
  createdAt: number
  updatedAt: number
}

type SessionCreateInput = {
  id: string
  repo: { url: string; ref: string }
  model?: { providerID: string; modelID: string }
  accountID?: string
  workspaceID?: string
  sandbox?: {
    provider?: string
    resources?: { cpu?: number; memoryMB?: number; diskGB?: number }
    ttl?: { ttlSeconds?: number; idleSeconds?: number }
    env?: Record<string, string>
    name?: string
  }
}

type SessionPromptInput = {
  text: string
  model?: { providerID: string; modelID: string }
  agent?: string
  variant?: string
  noReply?: boolean
}

type PrCreateInput = {
  sessionId: string
  repo: { owner: string; name: string }
  base: string
  head: string
  accountID?: string
  workspaceID?: string
  title?: string
  body?: string
}

type SandboxPushEvent = {
  type: "sandbox.push"
  idempotencyKey: string
  sessionId: string
  repo: { owner: string; name: string }
  base: string
  head: string
  commitSha: string
  title?: string
  body?: string
  accountID?: string
  workspaceID?: string
  githubToken?: string
  actor?: { userId?: string; githubLogin?: string }
  timestamp?: string
}

type SessionEventType =
  | "sandbox.push"
  | "pr.created"
  | "pr.reused"
  | "pr.updated"
  | "pr.closed"
  | "pr.merged"
  | "pr.failed"
  | "checks.updated"
  | "branch.updated"

type SessionEventRecord = {
  id: string
  sessionId: string
  type: SessionEventType
  payload: Record<string, any>
  timestamp: number
}

type SessionPrRecord = {
  sessionId: string
  repo: { owner: string; name: string }
  base: string
  head: string
  prNumber: number
  prUrl: string
  state: "open" | "closed" | "merged" | "unknown"
  createdAt: number
  updatedAt: number
}

type SessionIndexEntry = {
  id: string
  repo: { url: string; ref: string }
  sandboxUrl?: string
  sandboxId?: string
  sandboxProvider?: string
  opencodeSessionID: string
  worktree?: string
  title?: string
  accountID?: string
  workspaceID?: string
  createdAt: number
  updatedAt: number
}

const SESSION_INDEX_PREFIX = "registry/session/"
const SESSION_EVENT_PREFIX = "session/event/"
const SESSION_PR_PREFIX = "session/pr/"
const SESSION_PR_INDEX_PREFIX = "session/pr-index/"
const SESSION_BRANCH_PREFIX = "session/branch/"
const SESSION_IDEMPOTENCY_PREFIX = "session/idempotency/"

function toSessionIndex(info: SessionInfo): SessionIndexEntry {
  return {
    id: info.id,
    repo: info.repo,
    sandboxUrl: info.sandbox.url,
    sandboxId: info.sandbox.id,
    sandboxProvider: info.sandbox.provider,
    opencodeSessionID: info.opencode.sessionID,
    worktree: info.worktree,
    title: info.title,
    accountID: info.accountID,
    workspaceID: info.workspaceID,
    createdAt: info.createdAt,
    updatedAt: info.updatedAt,
  }
}

export class SyncServer extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
  }
  async fetch() {
    console.log("SyncServer subscribe")

    const webSocketPair = new WebSocketPair()
    const [client, server] = Object.values(webSocketPair)

    this.ctx.acceptWebSocket(server)

    const data = await this.ctx.storage.list()
    Array.from(data.entries())
      .filter(([key, _]) => key.startsWith("session/"))
      .map(([key, content]) => server.send(JSON.stringify({ key, content })))

    return new Response(null, {
      status: 101,
      webSocket: client,
    })
  }

  async webSocketMessage(ws, message) {}

  async webSocketClose(ws, code, reason, wasClean) {
    ws.close(code, "Durable Object is closing WebSocket")
  }

  async publish(key: string, content: any) {
    const sessionID = await this.getSessionID()
    if (
      !key.startsWith(`session/info/${sessionID}`) &&
      !key.startsWith(`session/message/${sessionID}/`) &&
      !key.startsWith(`session/part/${sessionID}/`)
    )
      return new Response("Error: Invalid key", { status: 400 })

    // store message
    await this.env.Bucket.put(`share/${key}.json`, JSON.stringify(content), {
      httpMetadata: {
        contentType: "application/json",
      },
    })
    await this.ctx.storage.put(key, content)
    const clients = this.ctx.getWebSockets()
    console.log("SyncServer publish", key, "to", clients.length, "subscribers")
    for (const client of clients) {
      client.send(JSON.stringify({ key, content }))
    }
  }

  public async share(sessionID: string) {
    let secret = await this.getSecret()
    if (secret) return secret
    secret = randomUUID()

    await this.ctx.storage.put("secret", secret)
    await this.ctx.storage.put("sessionID", sessionID)

    return secret
  }

  public async getData() {
    const data = (await this.ctx.storage.list()) as Map<string, any>
    return Array.from(data.entries())
      .filter(([key, _]) => key.startsWith("session/"))
      .map(([key, content]) => ({ key, content }))
  }

  public async assertSecret(secret: string) {
    if (secret !== (await this.getSecret())) throw new Error("Invalid secret")
  }

  private async getSecret() {
    return this.ctx.storage.get<string>("secret")
  }

  private async getSessionID() {
    return this.ctx.storage.get<string>("sessionID")
  }

  async clear() {
    const sessionID = await this.getSessionID()
    const list = await this.env.Bucket.list({
      prefix: `session/message/${sessionID}/`,
      limit: 1000,
    })
    for (const item of list.objects) {
      await this.env.Bucket.delete(item.key)
    }
    await this.env.Bucket.delete(`session/info/${sessionID}`)
    await this.ctx.storage.deleteAll()
  }

  static shortName(id: string) {
    return id.substring(id.length - 8)
  }
}

export class SessionRegistry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
  }

  async fetch(request: Request) {
    const url = new URL(request.url)
    const path = url.pathname

    if (request.method === "POST" && path === "/init") {
      const body = (await request.json()) as SessionCreateInput
      return this.handleInit(body)
    }

    if (request.method === "POST" && path === "/prompt") {
      const body = (await request.json()) as SessionPromptInput
      return this.handlePrompt(body)
    }

    if (request.method === "GET" && path === "/poll") {
      const limit = url.searchParams.get("limit")
      const parsedLimit = limit ? Number(limit) : undefined
      return this.handlePoll(Number.isFinite(parsedLimit) ? parsedLimit : undefined)
    }

    if (request.method === "GET" && path === "/info") {
      const info = await this.getInfo()
      if (!info) return new Response("Session not initialized", { status: 404 })
      return new Response(JSON.stringify(info), {
        headers: { "content-type": "application/json" },
      })
    }

    if (request.method === "DELETE" && path === "/delete") {
      await this.ctx.storage.deleteAll()
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      })
    }

    return new Response("Not Found", { status: 404 })
  }

  private async handleInit(input: SessionCreateInput) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const existing = await this.getInfo()
      if (existing) {
        await writeSessionIndex(this.env, existing)
        return new Response(JSON.stringify(existing), {
          headers: { "content-type": "application/json" },
        })
      }

      if (!input.repo?.url || !input.repo?.ref) {
        return new Response("repo.url and repo.ref are required", { status: 400 })
      }
      if (input.model) {
        const allowedProviders = new Set(["openai", "google"])
        if (!allowedProviders.has(input.model.providerID)) {
          return new Response("Model provider is not allowed", { status: 400 })
        }
      }

      const sandboxHandle = await createSandbox(this.env, input)
      if (!sandboxHandle.url) {
        return new Response("Sandbox url is missing", { status: 502 })
      }

      const opencodeSession = await createOpencodeSession(sandboxHandle.url)
      const [worktree, title] = await Promise.all([
        resolveSandboxWorktree(sandboxHandle.url),
        resolveSessionTitle(sandboxHandle.url, opencodeSession.id),
      ])
      const now = Date.now()
      const info: SessionInfo = {
        id: input.id,
        repo: input.repo,
        sandbox: sandboxHandle,
        opencode: { sessionID: opencodeSession.id },
        model: input.model,
        worktree: worktree ?? "/work/repo",
        title,
        accountID: input.accountID,
        workspaceID: input.workspaceID,
        createdAt: now,
        updatedAt: now,
      }

      await this.ctx.storage.put("info", info)
      await writeSessionIndex(this.env, info)

      return new Response(JSON.stringify(info), {
        headers: { "content-type": "application/json" },
      })
    })
  }

  private async handlePrompt(input: SessionPromptInput) {
    const info = await this.getInfo()
    if (!info) return new Response("Session not initialized", { status: 404 })
    if (!info.sandbox.url) return new Response("Sandbox url is missing", { status: 502 })

    const allowedProviders = new Set(["openai", "google"])
    const candidateModel = input.model ?? info.model
    if (candidateModel && !allowedProviders.has(candidateModel.providerID)) {
      return new Response("Model provider is not allowed", { status: 400 })
    }

    const body = {
      parts: [{ type: "text", text: input.text }],
      model: candidateModel,
      agent: input.agent,
      variant: input.variant,
      noReply: input.noReply,
    }
    const response = await fetch(new URL(`/session/${info.opencode.sessionID}/prompt_async`, info.sandbox.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      return new Response(`Prompt failed: ${detail || response.statusText}`, { status: 502 })
    }

    await this.touchInfo(info)
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    })
  }

  private async handlePoll(limit?: number) {
    const info = await this.getInfo()
    if (!info) return new Response("Session not initialized", { status: 404 })
    if (!info.sandbox.url) return new Response("Sandbox url is missing", { status: 502 })

    const messagesUrl = new URL(`/session/${info.opencode.sessionID}/message`, info.sandbox.url)
    if (limit) messagesUrl.searchParams.set("limit", String(limit))

    const statusUrl = new URL("/session/status", info.sandbox.url)

    const [messagesRes, statusRes] = await Promise.all([fetch(messagesUrl), fetch(statusUrl)])
    if (!messagesRes.ok) {
      const detail = await messagesRes.text().catch(() => "")
      return new Response(`Messages fetch failed: ${detail || messagesRes.statusText}`, { status: 502 })
    }
    if (!statusRes.ok) {
      const detail = await statusRes.text().catch(() => "")
      return new Response(`Status fetch failed: ${detail || statusRes.statusText}`, { status: 502 })
    }

    const messages = await messagesRes.json()
    const statusMap = (await statusRes.json()) as Record<string, any>
    const status = statusMap[info.opencode.sessionID] ?? { type: "idle" }

    await this.touchInfo(info)

    return new Response(JSON.stringify({ status, messages }), {
      headers: { "content-type": "application/json" },
    })
  }

  private async getInfo() {
    return this.ctx.storage.get<SessionInfo>("info")
  }

  private async touchInfo(info: SessionInfo) {
    const updated: SessionInfo = { ...info, updatedAt: Date.now() }
    await this.ctx.storage.put("info", updated)
    await writeSessionIndex(this.env, updated)
  }
}

export default new Hono<{ Bindings: Env }>()
  .use(
    cors({
      origin: "*",
      allowMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    }),
  )
  .get("/", (c) => c.text("Hello, world!"))
  .get("/global/health", (c) => {
    return c.json({ healthy: true, version: "inspect-edge" })
  })
  .get("/path", (c) => {
    return c.json({
      home: "/",
      state: "/",
      config: "/",
      worktree: "/",
      directory: "/",
    })
  })
  .get("/project", (c) => c.json([]))
  .get("/project/current", (c) => {
    return c.json({
      id: "remote",
      worktree: "/",
      sandboxes: [],
      time: {
        created: Date.now(),
        updated: Date.now(),
      },
    })
  })
  .get("/provider", (c) => {
    return c.json({ all: [], default: {}, connected: [] })
  })
  .get("/provider/auth", (c) => c.json({}))
  .post("/pr/create", async (c) => {
    const authHeader = c.req.header("authorization")
    const body = (await c.req.json().catch(() => undefined)) as PrCreateInput | undefined
    if (!body) return c.json({ error: "Invalid JSON body" }, { status: 400 })

    const missing: string[] = []
    if (!isNonEmptyString(body.sessionId)) missing.push("sessionId")
    if (!isNonEmptyString(body.base)) missing.push("base")
    if (!isNonEmptyString(body.head)) missing.push("head")
    if (!body.repo || !isNonEmptyString(body.repo.owner) || !isNonEmptyString(body.repo.name)) {
      missing.push("repo.owner")
      missing.push("repo.name")
    }
    if (missing.length) {
      return c.json({ error: `Missing or invalid fields: ${Array.from(new Set(missing)).join(", ")}` }, { status: 400 })
    }

    const sessionId = body.sessionId.trim()
    const repo = { owner: body.repo.owner.trim(), name: body.repo.name.trim() }
    const base = body.base.trim()
    const head = body.head.trim()
    let token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : authHeader
    const accountID = body.accountID?.trim()
    const workspaceID = body.workspaceID?.trim()
    if (isNonEmptyString(accountID) && isNonEmptyString(workspaceID)) {
      const resolved = await resolveGithubTokenFromConsole(c.env, {
        accountID,
        workspaceID,
        repo,
      })
      if (!resolved.token) {
        return c.json({ error: resolved.error ?? "Failed to resolve GitHub token" }, { status: resolved.status ?? 502 })
      }
      if (!token) token = resolved.token
    } else if (!token) {
      return c.json({ error: "Authorization header or accountID/workspaceID is required" }, { status: 401 })
    }

    try {
      const result = await createOrReusePr(c.env, {
        sessionId,
        repo,
        base,
        head,
        token,
        title: body.title,
        body: body.body,
      })
      return c.json({ ...result.record, reused: result.reused })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create PR"
      await writeSessionEvent(c.env, {
        id: randomUUID(),
        sessionId,
        type: "pr.failed",
        payload: { repo, base, head, error: message },
        timestamp: Date.now(),
      })
      return c.json({ error: message }, { status: 502 })
    }
  })
  .post("/sandbox/events", async (c) => {
    const authHeader = c.req.header("authorization") ?? c.req.header("x-opencode-sandbox-secret")
    const authToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : authHeader
    if (!authToken || authToken !== Resource.ADMIN_SECRET.value) {
      return c.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = (await c.req.json().catch(() => undefined)) as SandboxPushEvent | undefined
    if (!body || body.type !== "sandbox.push") {
      return c.json({ error: "Unsupported or missing event type" }, { status: 400 })
    }

    const missing: string[] = []
    if (!isNonEmptyString(body.idempotencyKey)) missing.push("idempotencyKey")
    if (!isNonEmptyString(body.sessionId)) missing.push("sessionId")
    if (!isNonEmptyString(body.base)) missing.push("base")
    if (!isNonEmptyString(body.head)) missing.push("head")
    if (!isNonEmptyString(body.commitSha)) missing.push("commitSha")
    if (!body.repo || !isNonEmptyString(body.repo.owner) || !isNonEmptyString(body.repo.name)) {
      missing.push("repo.owner")
      missing.push("repo.name")
    }
    if (missing.length) {
      return c.json({ error: `Missing or invalid fields: ${Array.from(new Set(missing)).join(", ")}` }, { status: 400 })
    }

    const idempotencyKey = body.idempotencyKey.trim()
    if (await hasIdempotencyKey(c.env, idempotencyKey)) {
      return c.json({ ok: true, duplicate: true })
    }

    const timestamp = parseTimestamp(body.timestamp) ?? Date.now()
    const eventId = randomUUID()
    const record: SessionEventRecord = {
      id: eventId,
      sessionId: body.sessionId,
      type: body.type,
      payload: body as unknown as Record<string, any>,
      timestamp,
    }

    await writeSessionEvent(c.env, record)
    await writeIdempotencyKey(c.env, idempotencyKey, {
      eventId,
      sessionId: body.sessionId,
      timestamp,
    })

    await writeSessionBranchIndex(c.env, {
      sessionId: body.sessionId,
      repo: { owner: body.repo.owner.trim(), name: body.repo.name.trim() },
      head: body.head.trim(),
      base: body.base.trim(),
    })

    const sessionIndex = await readSessionIndex(c.env, body.sessionId)
    const resolvedAccountID = isNonEmptyString(body.accountID)
      ? body.accountID.trim()
      : isNonEmptyString(sessionIndex?.accountID)
        ? sessionIndex?.accountID
        : undefined
    const resolvedWorkspaceID = isNonEmptyString(body.workspaceID)
      ? body.workspaceID.trim()
      : isNonEmptyString(sessionIndex?.workspaceID)
        ? sessionIndex?.workspaceID
        : undefined

    let token = isNonEmptyString(body.githubToken) ? body.githubToken.trim() : undefined
    if (!token && isNonEmptyString(resolvedAccountID) && isNonEmptyString(resolvedWorkspaceID)) {
      const resolved = await resolveGithubTokenFromConsole(c.env, {
        accountID: resolvedAccountID,
        workspaceID: resolvedWorkspaceID,
        repo: { owner: body.repo.owner.trim(), name: body.repo.name.trim() },
      })
      if (resolved.token) token = resolved.token
    }

    if (!token) {
      await writeSessionEvent(c.env, {
        id: randomUUID(),
        sessionId: body.sessionId,
        type: "pr.failed",
        payload: {
          repo: body.repo,
          base: body.base,
          head: body.head,
          error: "Missing GitHub token for PR creation",
        },
        timestamp: Date.now(),
      })
      return c.json({ ok: true, eventId, pr: { skipped: true, reason: "missing_token" } })
    }

    try {
      const result = await createOrReusePr(c.env, {
        sessionId: body.sessionId,
        repo: { owner: body.repo.owner.trim(), name: body.repo.name.trim() },
        base: body.base.trim(),
        head: body.head.trim(),
        token,
        title: body.title,
        body: body.body,
      })
      return c.json({ ok: true, eventId, pr: { ...result.record, reused: result.reused } })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create PR"
      await writeSessionEvent(c.env, {
        id: randomUUID(),
        sessionId: body.sessionId,
        type: "pr.failed",
        payload: { repo: body.repo, base: body.base, head: body.head, error: message },
        timestamp: Date.now(),
      })
      return c.json({ ok: true, eventId, pr: { failed: true, error: message } }, { status: 202 })
    }
  })
  .post("/github/webhook", async (c) => {
    const event = c.req.header("x-github-event") ?? ""
    const signature = c.req.header("x-hub-signature-256") ?? ""
    const bodyText = await c.req.text()

    const secret = c.env.GITHUB_WEBHOOK_SECRET ?? Resource.ADMIN_SECRET.value
    if (!secret) {
      return c.json({ error: "Webhook secret not configured" }, { status: 500 })
    }
    if (!signature || !(await verifyGithubSignature(secret, signature, bodyText))) {
      return c.json({ error: "Invalid webhook signature" }, { status: 401 })
    }

    if (event === "ping") {
      return c.json({ ok: true })
    }

    let payload: any
    try {
      payload = JSON.parse(bodyText)
    } catch {
      return c.json({ error: "Invalid JSON body" }, { status: 400 })
    }

    if (event === "pull_request") {
      const repo = payload.repository
      const owner = resolveRepoOwner(repo)
      const name = repo?.name
      const prNumber = payload.pull_request?.number
      if (!owner || !name || !prNumber) {
        return c.json({ ok: true, skipped: "missing_repo" })
      }
      const sessionIndex = await readSessionPrIndex(c.env, { repo: { owner, name }, prNumber })
      const sessionId = sessionIndex?.sessionId
      if (!sessionId) {
        return c.json({ ok: true, skipped: "unknown_pr" })
      }

      const action = payload.action
      const merged = Boolean(payload.pull_request?.merged_at || payload.pull_request?.merged)
      const type: SessionEventType =
        action === "closed" ? (merged ? "pr.merged" : "pr.closed") : "pr.updated"
      const now = Date.now()

      const existing = await readSessionPr(c.env, sessionId)
      if (existing) {
        const nextState: SessionPrRecord["state"] =
          merged ? "merged" : payload.pull_request?.state ?? existing.state ?? "unknown"
        await writeSessionPr(c.env, { ...existing, state: nextState, updatedAt: now })
      }

      await writeSessionEvent(c.env, {
        id: randomUUID(),
        sessionId,
        type,
        payload: {
          action,
          repo: { owner, name },
          prNumber,
          prUrl: payload.pull_request?.html_url,
          base: payload.pull_request?.base?.ref,
          head: payload.pull_request?.head?.ref,
          merged,
          state: payload.pull_request?.state,
        },
        timestamp: now,
      })
      return c.json({ ok: true })
    }

    if (event === "push") {
      const repo = payload.repository
      const owner = resolveRepoOwner(repo)
      const name = repo?.name
      const ref = typeof payload.ref === "string" ? payload.ref : ""
      const head = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ""
      if (!owner || !name || !head) {
        return c.json({ ok: true, skipped: "missing_branch" })
      }
      const sessionIndex = await readSessionBranchIndex(c.env, { repo: { owner, name }, head })
      const sessionId = sessionIndex?.sessionId
      if (!sessionId) {
        return c.json({ ok: true, skipped: "unknown_branch" })
      }

      await writeSessionEvent(c.env, {
        id: randomUUID(),
        sessionId,
        type: "branch.updated",
        payload: {
          repo: { owner, name },
          head,
          base: sessionIndex?.base,
          commitSha: payload.after,
          forced: payload.forced,
          compare: payload.compare,
        },
        timestamp: Date.now(),
      })
      return c.json({ ok: true })
    }

    return c.json({ ok: true })
  })
  .post("/session", async (c) => {
    const body = (await c.req.json()) as Partial<SessionCreateInput>
    if (!body.repo?.url || !body.repo?.ref) {
      return c.json({ error: "repo.url and repo.ref are required" }, { status: 400 })
    }

    const sessionID = body.id ?? randomUUID()
    const baseUrl = new URL(c.req.url).origin
    const sandboxEnv: Record<string, string> = {
      ...(body.sandbox?.env ?? {}),
      OPENCODE_API_URL: baseUrl,
      OPENCODE_SANDBOX_EVENT_SECRET: Resource.ADMIN_SECRET.value,
    }
    if (isNonEmptyString(body.accountID)) {
      sandboxEnv.OPENCODE_ACCOUNT_ID = body.accountID.trim()
    }
    if (isNonEmptyString(body.workspaceID)) {
      sandboxEnv.OPENCODE_WORKSPACE_ID = body.workspaceID.trim()
    }
    const githubRepo = parseGithubRepoUrl(body.repo.url)
    if (githubRepo) {
      try {
        const appToken = await resolveGithubAppInstallationToken(githubRepo)
        if (appToken.token) {
          sandboxEnv.OPENCODE_GITHUB_APP_TOKEN = appToken.token
          if (!sandboxEnv.OPENCODE_GITHUB_TOKEN) {
            sandboxEnv.OPENCODE_GITHUB_TOKEN = appToken.token
          }
        } else if (appToken.error) {
          console.warn("github app token not set", { error: appToken.error, repo: githubRepo })
        }
      } catch (error) {
        console.warn("github app token lookup failed", {
          error: error instanceof Error ? error.message : String(error),
          repo: githubRepo,
        })
      }
    }
    const sandboxConfig = body.sandbox
      ? { ...body.sandbox, env: sandboxEnv }
      : Object.keys(sandboxEnv).length > 0
        ? { env: sandboxEnv }
        : undefined
    const payload: SessionCreateInput = {
      id: sessionID,
      repo: body.repo,
      model: body.model,
      accountID: body.accountID,
      workspaceID: body.workspaceID,
      sandbox: sandboxConfig,
    }

    const registry = c.env.SESSION_REGISTRY
    if (registry) {
      const id = registry.idFromName(sessionID)
      const stub = registry.get(id)
      const response = await stub.fetch("https://session/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => "")
        return c.json({ error: detail || response.statusText }, { status: response.status })
      }
      return c.json(await response.json())
    }

    try {
      const sandbox = await createSandbox(c.env, payload)
      if (!sandbox.url) {
        return c.json({ error: "Sandbox url is missing" }, { status: 502 })
      }
      const opencode = await createOpencodeSession(sandbox.url)
      const [worktree, title] = await Promise.all([
        resolveSandboxWorktree(sandbox.url),
        resolveSessionTitle(sandbox.url, opencode.id),
      ])
      const now = Date.now()
      await writeSessionIndex(c.env, {
        id: sessionID,
        repo: payload.repo,
        sandbox,
        opencode: { sessionID: opencode.id },
        model: payload.model,
        worktree: worktree ?? "/work/repo",
        title,
        accountID: payload.accountID,
        workspaceID: payload.workspaceID,
        createdAt: now,
        updatedAt: now,
      })
      return c.json({
        id: sessionID,
        repo: payload.repo,
        sandbox,
        opencode: { sessionID: opencode.id },
        model: payload.model,
        accountID: payload.accountID,
        workspaceID: payload.workspaceID,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sandbox create failed"
      return c.json({ error: message }, { status: 502 })
    }
  })
  .get("/session", async (c) => {
    const limit = c.req.query("limit")
    const cursor = c.req.query("cursor")
    const parsedLimit = limit ? Number(limit) : undefined
    const list = await listSessionIndex(c.env, {
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
      cursor: cursor || undefined,
    })
    return c.json(list)
  })
  .get("/session/:sessionID", async (c) => {
    const sessionID = c.req.param("sessionID")
    const registry = c.env.SESSION_REGISTRY
    if (!registry) {
      return c.json({ error: "Session registry disabled" }, { status: 501 })
    }
    const stub = registry.get(registry.idFromName(sessionID))
    const response = await stub.fetch("https://session/info")
    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      return c.json({ error: detail || response.statusText }, { status: response.status })
    }
    return c.json(await response.json())
  })
  .delete("/session/:sessionID", async (c) => {
    const sessionID = c.req.param("sessionID")
    const entry = await readSessionIndex(c.env, sessionID)
    if (!entry) return c.json({ error: "Session not found" }, { status: 404 })

    let info: SessionInfo | undefined
    const registry = c.env.SESSION_REGISTRY
    if (registry) {
      const stub = registry.get(registry.idFromName(sessionID))
      const response = await stub.fetch("https://session/info")
      if (response.ok) {
        info = (await response.json()) as SessionInfo
      }
    }

    let warning: string | undefined
    const derivedSandbox = deriveSandboxFromUrl(entry.sandboxUrl)
    const sandboxId = info?.sandbox?.id ?? entry.sandboxId ?? derivedSandbox?.id
    const sandboxProvider = info?.sandbox?.provider ?? entry.sandboxProvider ?? derivedSandbox?.provider
    if (sandboxId) {
      try {
        await stopSandbox(c.env, { id: sandboxId, provider: sandboxProvider })
      } catch (error) {
        warning = error instanceof Error ? error.message : "Failed to stop sandbox"
      }
    } else {
      warning = "Sandbox id missing; session removed without stopping the sandbox."
    }

    await c.env.Bucket.delete(`${SESSION_INDEX_PREFIX}${sessionID}.json`)

    const prRecord = await readSessionPr(c.env, sessionID)
    if (prRecord) {
      await c.env.Bucket.delete(prKey(sessionID))
      await c.env.Bucket.delete(prIndexKey(prRecord.repo, prRecord.prNumber))
      await c.env.Bucket.delete(branchKey(prRecord.repo, prRecord.head))
    }

    await deleteSessionEvents(c.env, sessionID)

    if (registry) {
      const stub = registry.get(registry.idFromName(sessionID))
      await stub.fetch("https://session/delete", { method: "DELETE" }).catch(() => undefined)
    }

    return c.json(warning ? { ok: true, warning } : { ok: true })
  })
  .get("/session/:sessionID/pr", async (c) => {
    const sessionID = c.req.param("sessionID")
    const record = await readSessionPr(c.env, sessionID)
    if (!record) return c.json({ error: "PR not found" }, { status: 404 })
    return c.json(record)
  })
  .get("/session/:sessionID/events", async (c) => {
    const sessionID = c.req.param("sessionID")
    const limit = c.req.query("limit")
    const cursor = c.req.query("cursor")
    const parsedLimit = limit ? Number(limit) : undefined
    const list = await listSessionEvents(c.env, {
      sessionID,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
      cursor: cursor || undefined,
    })
    return c.json(list)
  })
  .post("/session/:sessionID/prompt", async (c) => {
    const sessionID = c.req.param("sessionID")
    const body = (await c.req.json()) as SessionPromptInput
    if (!body?.text) {
      return c.json({ error: "text is required" }, { status: 400 })
    }
    const registry = c.env.SESSION_REGISTRY
    if (!registry) {
      return c.json({ error: "Session registry disabled" }, { status: 501 })
    }
    const stub = registry.get(registry.idFromName(sessionID))
    const response = await stub.fetch("https://session/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      return c.json({ error: detail || response.statusText }, { status: response.status })
    }
    return c.json(await response.json())
  })
  .get("/session/:sessionID/poll", async (c) => {
    const sessionID = c.req.param("sessionID")
    const limit = c.req.query("limit")
    const url = new URL("https://session/poll")
    if (limit) url.searchParams.set("limit", limit)
    const registry = c.env.SESSION_REGISTRY
    if (!registry) {
      return c.json({ error: "Session registry disabled" }, { status: 501 })
    }
    const stub = registry.get(registry.idFromName(sessionID))
    const response = await stub.fetch(url.toString())
    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      return c.json({ error: detail || response.statusText }, { status: response.status })
    }
    return c.json(await response.json())
  })
  .post("/share_create", async (c) => {
    if (!c.env.SYNC_SERVER) {
      return c.json({ error: "Share disabled" }, { status: 501 })
    }
    const body = await c.req.json<{ sessionID: string }>()
    const sessionID = body.sessionID
    const short = SyncServer.shortName(sessionID)
    const id = c.env.SYNC_SERVER.idFromName(short)
    const stub = c.env.SYNC_SERVER.get(id)
    const secret = await stub.share(sessionID)
    return c.json({
      secret,
      url: `https://${c.env.WEB_DOMAIN}/s/${short}`,
    })
  })
  .post("/share_delete", async (c) => {
    if (!c.env.SYNC_SERVER) {
      return c.json({ error: "Share disabled" }, { status: 501 })
    }
    const body = await c.req.json<{ sessionID: string; secret: string }>()
    const sessionID = body.sessionID
    const secret = body.secret
    const id = c.env.SYNC_SERVER.idFromName(SyncServer.shortName(sessionID))
    const stub = c.env.SYNC_SERVER.get(id)
    await stub.assertSecret(secret)
    await stub.clear()
    return c.json({})
  })
  .post("/share_delete_admin", async (c) => {
    if (!c.env.SYNC_SERVER) {
      return c.json({ error: "Share disabled" }, { status: 501 })
    }
    const body = await c.req.json<{ sessionShortName: string; adminSecret: string }>()
    const sessionShortName = body.sessionShortName
    const adminSecret = body.adminSecret
    if (adminSecret !== Resource.ADMIN_SECRET.value) throw new Error("Invalid admin secret")
    const id = c.env.SYNC_SERVER.idFromName(sessionShortName)
    const stub = c.env.SYNC_SERVER.get(id)
    await stub.clear()
    return c.json({})
  })
  .post("/share_sync", async (c) => {
    if (!c.env.SYNC_SERVER) {
      return c.json({ error: "Share disabled" }, { status: 501 })
    }
    const body = await c.req.json<{
      sessionID: string
      secret: string
      key: string
      content: any
    }>()
    const name = SyncServer.shortName(body.sessionID)
    const id = c.env.SYNC_SERVER.idFromName(name)
    const stub = c.env.SYNC_SERVER.get(id)
    await stub.assertSecret(body.secret)
    await stub.publish(body.key, body.content)
    return c.json({})
  })
  .get("/share_poll", async (c) => {
    if (!c.env.SYNC_SERVER) {
      return c.json({ error: "Share disabled" }, { status: 501 })
    }
    const upgradeHeader = c.req.header("Upgrade")
    if (!upgradeHeader || upgradeHeader !== "websocket") {
      return c.text("Error: Upgrade header is required", { status: 426 })
    }
    const id = c.req.query("id")
    console.log("share_poll", id)
    if (!id) return c.text("Error: Share ID is required", { status: 400 })
    const stub = c.env.SYNC_SERVER.get(c.env.SYNC_SERVER.idFromName(id))
    return stub.fetch(c.req.raw)
  })
  .get("/share_data", async (c) => {
    if (!c.env.SYNC_SERVER) {
      return c.json({ error: "Share disabled" }, { status: 501 })
    }
    const id = c.req.query("id")
    console.log("share_data", id)
    if (!id) return c.text("Error: Share ID is required", { status: 400 })
    const stub = c.env.SYNC_SERVER.get(c.env.SYNC_SERVER.idFromName(id))
    const data = await stub.getData()

    let info
    const messages: Record<string, any> = {}
    data.forEach((d) => {
      const [root, type, ...splits] = d.key.split("/")
      if (root !== "session") return
      if (type === "info") {
        info = d.content
        return
      }
      if (type === "message") {
        messages[d.content.id] = {
          parts: [],
          ...d.content,
        }
      }
      if (type === "part") {
        messages[d.content.messageID].parts.push(d.content)
      }
    })

    return c.json({ info, messages })
  })
  /**
   * Used by the GitHub action to get GitHub installation access token given the OIDC token
   */
  .post("/exchange_github_app_token", async (c) => {
    const EXPECTED_AUDIENCE = "opencode-github-action"
    const GITHUB_ISSUER = "https://token.actions.githubusercontent.com"
    const JWKS_URL = `${GITHUB_ISSUER}/.well-known/jwks`

    // get Authorization header
    const token = c.req.header("Authorization")?.replace(/^Bearer /, "")
    if (!token) return c.json({ error: "Authorization header is required" }, { status: 401 })

    // verify token
    const JWKS = createRemoteJWKSet(new URL(JWKS_URL))
    let owner, repo
    try {
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: GITHUB_ISSUER,
        audience: EXPECTED_AUDIENCE,
      })
      const sub = payload.sub // e.g. 'repo:my-org/my-repo:ref:refs/heads/main'
      const parts = sub.split(":")[1].split("/")
      owner = parts[0]
      repo = parts[1]
    } catch (err) {
      console.error("Token verification failed:", err)
      return c.json({ error: "Invalid or expired token" }, { status: 403 })
    }

    // Create app JWT token
    const auth = createAppAuth({
      appId: Resource.GITHUB_APP_ID.value,
      privateKey: Resource.GITHUB_APP_PRIVATE_KEY.value,
    })
    const appAuth = await auth({ type: "app" })

    // Lookup installation
    const octokit = new Octokit({ auth: appAuth.token })
    const { data: installation } = await octokit.apps.getRepoInstallation({
      owner,
      repo,
    })

    // Get installation token
    const installationAuth = await auth({
      type: "installation",
      installationId: installation.id,
    })

    return c.json({ token: installationAuth.token })
  })
  /**
   * Used by the GitHub action to get GitHub installation access token given user PAT token (used when testing `opencode github run` locally)
   */
  .post("/exchange_github_app_token_with_pat", async (c) => {
    const body = await c.req.json<{ owner: string; repo: string }>()
    const owner = body.owner
    const repo = body.repo

    try {
      // get Authorization header
      const authHeader = c.req.header("Authorization")
      const token = authHeader?.replace(/^Bearer /, "")
      if (!token) throw new Error("Authorization header is required")

      // Verify permissions
      const userClient = new Octokit({ auth: token })
      const { data: repoData } = await userClient.repos.get({ owner, repo })
      if (!repoData.permissions.admin && !repoData.permissions.push && !repoData.permissions.maintain)
        throw new Error("User does not have write permissions")

      // Get installation token
      const auth = createAppAuth({
        appId: Resource.GITHUB_APP_ID.value,
        privateKey: Resource.GITHUB_APP_PRIVATE_KEY.value,
      })
      const appAuth = await auth({ type: "app" })

      // Lookup installation
      const appClient = new Octokit({ auth: appAuth.token })
      const { data: installation } = await appClient.apps.getRepoInstallation({
        owner,
        repo,
      })

      // Get installation token
      const installationAuth = await auth({
        type: "installation",
        installationId: installation.id,
      })

      return c.json({ token: installationAuth.token })
    } catch (e: any) {
      let error = e
      if (e instanceof Error) {
        error = e.message
      }

      return c.json({ error }, { status: 401 })
    }
  })
  /**
   * Used by the opencode CLI to check if the GitHub app is installed
   */
  .get("/get_github_app_installation", async (c) => {
    const owner = c.req.query("owner")
    const repo = c.req.query("repo")

    const auth = createAppAuth({
      appId: Resource.GITHUB_APP_ID.value,
      privateKey: Resource.GITHUB_APP_PRIVATE_KEY.value,
    })
    const appAuth = await auth({ type: "app" })

    // Lookup installation
    const octokit = new Octokit({ auth: appAuth.token })
    let installation
    try {
      const ret = await octokit.apps.getRepoInstallation({ owner, repo })
      installation = ret.data
    } catch (err) {
      if (err instanceof Error && err.message.includes("Not Found")) {
        // not installed
      } else {
        throw err
      }
    }

    return c.json({ installation })
  })
  .all("*", (c) => c.text("Not Found"))
async function createSandbox(env: Env, input: SessionCreateInput) {
  const controllerUrl = env.SANDBOX_CONTROLLER_URL
  if (!controllerUrl) {
    throw new Error("SANDBOX_CONTROLLER_URL is not configured")
  }

  const body = {
    provider: input.sandbox?.provider,
    repo: input.repo,
    resources: input.sandbox?.resources,
    ttl: input.sandbox?.ttl,
    env: input.sandbox?.env,
    name: input.sandbox?.name,
  }

  const response = await fetch(new URL("/sandbox/create", controllerUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`sandbox create failed: ${detail || response.statusText}`)
  }
  return (await response.json()) as SandboxHandle
}

async function stopSandbox(env: Env, input: { id: string; provider?: string }) {
  const controllerUrl = env.SANDBOX_CONTROLLER_URL
  if (!controllerUrl) {
    throw new Error("SANDBOX_CONTROLLER_URL is not configured")
  }

  const response = await fetch(new URL("/sandbox/stop", controllerUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: input.id, provider: input.provider }),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`sandbox stop failed: ${detail || response.statusText}`)
  }
}

async function createOpencodeSession(baseUrl: string) {
  const response = await fetch(new URL("/session", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`opencode session create failed: ${detail || response.statusText}`)
  }
  return (await response.json()) as { id: string }
}

async function resolveSandboxWorktree(baseUrl: string) {
  try {
    const response = await fetch(new URL("/project/current", baseUrl), {
      signal: AbortSignal.timeout(2500),
    })
    if (!response.ok) return undefined
    const project = (await response.json()) as { worktree?: string }
    if (typeof project?.worktree === "string" && project.worktree.trim()) return project.worktree
  } catch {}
  return undefined
}

async function resolveSessionTitle(baseUrl: string, sessionID: string) {
  try {
    const response = await fetch(new URL(`/session/${sessionID}`, baseUrl), {
      signal: AbortSignal.timeout(2500),
    })
    if (!response.ok) return undefined
    const session = (await response.json()) as { title?: string }
    if (typeof session?.title === "string" && session.title.trim()) return session.title
  } catch {}
  return undefined
}

async function writeSessionIndex(env: Env, info: SessionInfo) {
  const key = `${SESSION_INDEX_PREFIX}${info.id}.json`
  await env.Bucket.put(key, JSON.stringify(toSessionIndex(info)), {
    httpMetadata: {
      contentType: "application/json",
    },
  })
}

async function listSessionIndex(env: Env, input: { limit?: number; cursor?: string }) {
  const limit = input.limit && input.limit > 0 ? Math.min(input.limit, 200) : 100
  const result = await env.Bucket.list({
    prefix: SESSION_INDEX_PREFIX,
    limit,
    cursor: input.cursor,
  })
  const items = await Promise.all(
    result.objects.map(async (obj) => {
      const data = await env.Bucket.get(obj.key)
      if (!data) return undefined
      return (await data.json()) as SessionIndexEntry
    }),
  )
  return {
    items: items.filter(Boolean),
    cursor: result.truncated ? result.cursor : undefined,
  }
}

function deriveSandboxFromUrl(url?: string): { id: string; provider: string } | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    const host = parsed.hostname
    if (host.endsWith(".modal.run") || host.endsWith(".modal.app")) {
      const subdomain = host.split(".")[0]
      const [, scoped] = subdomain.split("--")
      const candidate = scoped || subdomain
      const trimmed = candidate.replace(/-op-[0-9a-f]+$/i, "")
      if (trimmed) return { id: trimmed, provider: "modal" }
    }
  } catch {}
  return undefined
}

async function deleteSessionEvents(env: Env, sessionID: string) {
  let cursor: string | undefined
  do {
    const result = await env.Bucket.list({
      prefix: `${SESSION_EVENT_PREFIX}${sessionID}/`,
      limit: 1000,
      cursor,
    })
    for (const item of result.objects) {
      await env.Bucket.delete(item.key)
    }
    cursor = result.truncated ? result.cursor : undefined
  } while (cursor)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function parseTimestamp(value?: string) {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function resolveRepoOwner(repo: any) {
  if (typeof repo?.owner?.login === "string") return repo.owner.login
  if (typeof repo?.owner?.name === "string") return repo.owner.name
  if (typeof repo?.owner?.username === "string") return repo.owner.username
  return undefined
}

function timingSafeEqual(left: string, right: string) {
  if (left.length !== right.length) return false
  let result = 0
  for (let i = 0; i < left.length; i += 1) {
    result |= left.charCodeAt(i) ^ right.charCodeAt(i)
  }
  return result === 0
}

async function hmacSha256Hex(secret: string, payload: string) {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload))
  const bytes = new Uint8Array(signature)
  let out = ""
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0")
  }
  return out
}

async function verifyGithubSignature(secret: string, signatureHeader: string, payload: string) {
  if (!signatureHeader.startsWith("sha256=")) return false
  const expected = `sha256=${await hmacSha256Hex(secret, payload)}`
  return timingSafeEqual(expected, signatureHeader)
}

function eventKey(sessionId: string, timestamp: number, eventId: string) {
  const padded = String(timestamp).padStart(13, "0")
  return `${SESSION_EVENT_PREFIX}${sessionId}/${padded}-${eventId}.json`
}

function prKey(sessionId: string) {
  return `${SESSION_PR_PREFIX}${sessionId}.json`
}

function prIndexKey(repo: { owner: string; name: string }, prNumber: number) {
  return `${SESSION_PR_INDEX_PREFIX}${repo.owner}/${repo.name}/${prNumber}.json`
}

function branchKey(repo: { owner: string; name: string }, head: string) {
  return `${SESSION_BRANCH_PREFIX}${repo.owner}/${repo.name}/${encodeURIComponent(head)}.json`
}

function idempotencyKeyPath(key: string) {
  return `${SESSION_IDEMPOTENCY_PREFIX}${encodeURIComponent(key)}.json`
}

async function hasIdempotencyKey(env: Env, key: string) {
  const existing = await env.Bucket.get(idempotencyKeyPath(key))
  return Boolean(existing)
}

async function writeIdempotencyKey(
  env: Env,
  key: string,
  record: { eventId: string; sessionId: string; timestamp: number },
) {
  await env.Bucket.put(idempotencyKeyPath(key), JSON.stringify(record), {
    httpMetadata: { contentType: "application/json" },
  })
}

async function writeSessionEvent(env: Env, record: SessionEventRecord) {
  const key = eventKey(record.sessionId, record.timestamp, record.id)
  await env.Bucket.put(key, JSON.stringify(record), {
    httpMetadata: { contentType: "application/json" },
  })
}

async function readSessionPr(env: Env, sessionId: string) {
  const data = await env.Bucket.get(prKey(sessionId))
  if (!data) return undefined
  return (await data.json()) as SessionPrRecord
}

async function writeSessionPr(env: Env, record: SessionPrRecord) {
  await env.Bucket.put(prKey(record.sessionId), JSON.stringify(record), {
    httpMetadata: { contentType: "application/json" },
  })
}

async function writeSessionPrIndex(env: Env, record: SessionPrRecord) {
  await env.Bucket.put(prIndexKey(record.repo, record.prNumber), JSON.stringify({ sessionId: record.sessionId }), {
    httpMetadata: { contentType: "application/json" },
  })
}

async function readSessionPrIndex(env: Env, input: { repo: { owner: string; name: string }; prNumber: number }) {
  const data = await env.Bucket.get(prIndexKey(input.repo, input.prNumber))
  if (!data) return undefined
  return (await data.json()) as { sessionId?: string }
}

async function writeSessionBranchIndex(
  env: Env,
  input: { sessionId: string; repo: { owner: string; name: string }; head: string; base?: string },
) {
  await env.Bucket.put(
    branchKey(input.repo, input.head),
    JSON.stringify({ sessionId: input.sessionId, base: input.base }),
    {
      httpMetadata: { contentType: "application/json" },
    },
  )
}

async function readSessionBranchIndex(env: Env, input: { repo: { owner: string; name: string }; head: string }) {
  const data = await env.Bucket.get(branchKey(input.repo, input.head))
  if (!data) return undefined
  return (await data.json()) as { sessionId?: string; base?: string }
}

async function readSessionIndex(env: Env, sessionId: string) {
  const data = await env.Bucket.get(`${SESSION_INDEX_PREFIX}${sessionId}.json`)
  if (!data) return undefined
  return (await data.json()) as SessionIndexEntry
}

function parseGithubRepoUrl(url: string) {
  const trimmed = url.trim()
  const match = trimmed.match(/github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/i)
  if (!match?.groups) return undefined
  return { owner: match.groups.owner, name: match.groups.repo }
}

async function resolveGithubAppInstallationToken(repo: { owner: string; name: string }) {
  const appId = Resource.GITHUB_APP_ID?.value
  const privateKey = Resource.GITHUB_APP_PRIVATE_KEY?.value
  if (!appId || !privateKey) {
    return { error: "GitHub app credentials not configured" }
  }

  const auth = createAppAuth({ appId, privateKey })
  const appAuth = await auth({ type: "app" })
  const octokit = new Octokit({ auth: appAuth.token })

  let installationId: number | undefined
  try {
    const { data } = await octokit.apps.getRepoInstallation({ owner: repo.owner, repo: repo.name })
    installationId = data?.id
  } catch (error) {
    return { error: "GitHub app not installed for repo" }
  }

  if (!installationId) {
    return { error: "GitHub app installation not found" }
  }

  const installationAuth = await auth({
    type: "installation",
    installationId,
  })
  return { token: installationAuth.token }
}

async function resolveGithubTokenFromConsole(
  env: Env,
  input: { accountID: string; workspaceID: string; repo: { owner: string; name: string } },
) {
  if (!env.CONSOLE_URL) {
    return { error: "CONSOLE_URL is not configured", status: 500 }
  }
  const baseUrl = env.CONSOLE_URL.replace(/\/+$/, "")
  const url = new URL("/api/inspect/github/pr-auth", baseUrl)
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${Resource.ADMIN_SECRET.value}`,
    },
    body: JSON.stringify({
      accountID: input.accountID,
      workspaceID: input.workspaceID,
      repo: input.repo,
    }),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    return { error: detail || response.statusText, status: response.status }
  }
  const data = (await response.json().catch(() => undefined)) as { token?: string } | undefined
  if (!data?.token) {
    return { error: "GitHub token not found", status: 404 }
  }
  return { token: data.token }
}

async function createOrReusePr(
  env: Env,
  input: {
    sessionId: string
    repo: { owner: string; name: string }
    base: string
    head: string
    token: string
    title?: string
    body?: string
  },
) {
  const existingMapping = await readSessionPr(env, input.sessionId)
  if (
    existingMapping &&
    existingMapping.repo.owner === input.repo.owner &&
    existingMapping.repo.name === input.repo.name &&
    existingMapping.base === input.base &&
    existingMapping.head === input.head
  ) {
    await writeSessionPrIndex(env, existingMapping)
    await writeSessionBranchIndex(env, {
      sessionId: existingMapping.sessionId,
      repo: existingMapping.repo,
      head: existingMapping.head,
      base: existingMapping.base,
    })
    await writeSessionEvent(env, {
      id: randomUUID(),
      sessionId: input.sessionId,
      type: "pr.reused",
      payload: {
        repo: input.repo,
        base: input.base,
        head: input.head,
        prNumber: existingMapping.prNumber,
        prUrl: existingMapping.prUrl,
      },
      timestamp: Date.now(),
    })
    return { record: existingMapping, reused: true }
  }

  const octokit = new Octokit({ auth: input.token })
  const repoData = await octokit.repos.get({ owner: input.repo.owner, repo: input.repo.name })
  const permissions = repoData.data.permissions
  const canWrite = Boolean(permissions?.admin || permissions?.push || permissions?.maintain)
  if (!canWrite) {
    throw new Error("User does not have write permissions")
  }

  const headRef = input.head.includes(":") ? input.head : `${input.repo.owner}:${input.head}`
  const existing = await octokit.pulls.list({
    owner: input.repo.owner,
    repo: input.repo.name,
    state: "open",
    head: headRef,
    base: input.base,
  })
  const existingPr = existing.data[0]
  const pr =
    existingPr ??
    (await octokit.pulls.create({
      owner: input.repo.owner,
      repo: input.repo.name,
      base: input.base,
      head: input.head,
      title: input.title?.trim() || `Session ${input.sessionId}`,
      body: input.body ?? "",
    })).data

  const now = Date.now()
  const record: SessionPrRecord = {
    sessionId: input.sessionId,
    repo: input.repo,
    base: input.base,
    head: input.head,
    prNumber: pr.number,
    prUrl: pr.html_url,
    state: pr.state === "closed" && pr.merged_at ? "merged" : pr.state ?? "unknown",
    createdAt: existingMapping?.createdAt ?? now,
    updatedAt: now,
  }

  await writeSessionPr(env, record)
  await writeSessionPrIndex(env, record)
  await writeSessionBranchIndex(env, {
    sessionId: record.sessionId,
    repo: record.repo,
    head: record.head,
    base: record.base,
  })
  await writeSessionEvent(env, {
    id: randomUUID(),
    sessionId: input.sessionId,
    type: existingPr ? "pr.reused" : "pr.created",
    payload: {
      repo: input.repo,
      base: input.base,
      head: input.head,
      prNumber: record.prNumber,
      prUrl: record.prUrl,
    },
    timestamp: now,
  })

  return { record, reused: Boolean(existingPr) }
}

async function listSessionEvents(
  env: Env,
  input: { sessionID: string; limit?: number; cursor?: string },
) {
  const limit = input.limit && input.limit > 0 ? Math.min(input.limit, 200) : 100
  const result = await env.Bucket.list({
    prefix: `${SESSION_EVENT_PREFIX}${input.sessionID}/`,
    limit,
    cursor: input.cursor,
  })
  const sorted = [...result.objects].sort((a, b) => a.key.localeCompare(b.key))
  const items = await Promise.all(
    sorted.map(async (obj) => {
      const data = await env.Bucket.get(obj.key)
      if (!data) return undefined
      return (await data.json()) as SessionEventRecord
    }),
  )
  return {
    items: items.filter(Boolean),
    cursor: result.truncated ? result.cursor : undefined,
  }
}
