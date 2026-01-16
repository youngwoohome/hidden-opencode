import type { APIEvent } from "@solidjs/start/server"
import { Resource } from "@opencode-ai/console-resource"
import { GithubToken } from "@opencode-ai/console-core/github-token.js"
import { GithubRepoAllowlist } from "@opencode-ai/console-core/github-repo-allowlist.js"

type RequestBody = {
  accountID: string
  workspaceID: string
  repo: { owner: string; name: string }
}

export async function POST(event: APIEvent) {
  const authHeader = event.request.headers.get("authorization") ?? event.request.headers.get("x-opencode-admin-secret")
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : authHeader
  if (!token || token !== Resource.ADMIN_SECRET.value) {
    return Response.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = (await event.request.json().catch(() => undefined)) as RequestBody | undefined
  if (!body?.accountID || !body?.workspaceID || !body?.repo?.owner || !body?.repo?.name) {
    return Response.json({ error: "accountID, workspaceID, repo.owner, repo.name are required" }, { status: 400 })
  }

  const allowed = await GithubRepoAllowlist.isAllowed({
    workspaceID: body.workspaceID,
    owner: body.repo.owner,
    repo: body.repo.name,
  })
  if (!allowed) return Response.json({ error: "Repo not allowlisted" }, { status: 403 })

  const record = await GithubToken.get({ accountID: body.accountID })
  if (!record) return Response.json({ error: "GitHub token not found" }, { status: 404 })

  return Response.json({ token: record.accessToken, scope: record.scope, tokenType: record.tokenType })
}
