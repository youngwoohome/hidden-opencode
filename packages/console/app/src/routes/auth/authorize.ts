import type { APIEvent } from "@solidjs/start/server"
import { getAuthClient, resolveIssuer } from "~/context/auth"
import { Resource } from "@opencode-ai/console-resource"

export async function GET(input: APIEvent) {
  const issuer = resolveIssuer()
  if (!issuer) {
    let resourceIssuer: string | undefined
    try {
      const raw = Resource.AUTH_API_URL
      resourceIssuer = typeof raw === "string" ? raw : raw?.value
    } catch {}
    console.error("Auth issuer missing", {
      envIssuer: import.meta.env.VITE_AUTH_URL,
      resourceIssuer,
    })
    return new Response("Auth issuer missing", { status: 500 })
  }
  const authClient = getAuthClient()
  if (!authClient) {
    return new Response("Auth issuer missing", { status: 500 })
  }
  try {
    const result = await authClient.authorize(new URL("./callback", input.request.url).toString(), "code")
    return Response.redirect(result.url, 302)
  } catch (err) {
    console.error("Auth authorize failed", err)
    throw err
  }
}
