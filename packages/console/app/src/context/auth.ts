import { getRequestEvent } from "solid-js/web"
import { and, Database, eq, inArray, isNull } from "@opencode-ai/console-core/drizzle/index.js"
import { UserTable } from "@opencode-ai/console-core/schema/user.sql.js"
import { redirect } from "@solidjs/router"
import { Actor } from "@opencode-ai/console-core/actor.js"

import { createClient } from "@openauthjs/openauth/client"
import { Resource } from "@opencode-ai/console-resource"
import { useAuthSession } from "./auth.session"

export const resolveIssuer = () => {
  const fromEnv = import.meta.env.VITE_AUTH_URL?.trim().replace(/\/+$/, "")
  if (fromEnv) return fromEnv
  try {
    const fromResource = Resource.AUTH_API_URL
    if (typeof fromResource === "string") return fromResource.trim().replace(/\/+$/, "")
    return fromResource?.value?.trim().replace(/\/+$/, "")
  } catch {
    return undefined
  }
}

const getAuthBinding = () => {
  try {
    const binding = Resource.AuthApi
    if (binding && typeof binding.fetch === "function") return binding
  } catch {}
  return undefined
}

const authFetch: typeof fetch = async (...args) => {
  const issuer = resolveIssuer()
  const url =
    typeof args[0] === "string"
      ? args[0]
      : args[0] instanceof URL
        ? args[0].toString()
        : (args[0] as Request).url
  const binding = getAuthBinding()
  if (binding && issuer && url.startsWith(issuer)) {
    const path = url.slice(issuer.length) || "/"
    const target = new URL(path, "https://auth.internal")
    const init: RequestInit | undefined =
      args[0] instanceof Request
        ? {
            method: args[0].method,
            headers: args[0].headers,
            body: args[0].body,
            redirect: args[0].redirect,
          }
        : args[1]
    const response = await binding.fetch(new Request(target.toString(), init))
    return {
      ok: response.ok,
      async json() {
        const text = await response.text()
        try {
          return JSON.parse(text)
        } catch (err) {
          console.error("Auth fetch returned non-JSON", {
            url,
            status: response.status,
            body: text.slice(0, 500),
          })
          throw err
        }
      },
    }
  }
  const response = await fetch(...args)
  return {
    ok: response.ok,
    async json() {
      const text = await response.text()
      try {
        return JSON.parse(text)
      } catch (err) {
        console.error("Auth fetch returned non-JSON", {
          url,
          status: response.status,
          body: text.slice(0, 500),
        })
        throw err
      }
    },
  }
}

export const getAuthClient = () => {
  const issuer = resolveIssuer()
  if (!issuer) return undefined
  return createClient({
    clientID: "app",
    issuer,
    fetch: authFetch,
  })
}

export const getActor = async (workspace?: string): Promise<Actor.Info> => {
  "use server"
  const evt = getRequestEvent()
  if (!evt) throw new Error("No request event")
  if (evt.locals.actor) return evt.locals.actor
  evt.locals.actor = (async () => {
    const auth = await useAuthSession()
    if (!workspace) {
      const account = auth.data.account ?? {}
      const current = account[auth.data.current ?? ""]
      if (current) {
        return {
          type: "account",
          properties: {
            email: current.email,
            accountID: current.id,
          },
        }
      }
      if (Object.keys(account).length > 0) {
        const current = Object.values(account)[0]
        await auth.update((val) => ({
          ...val,
          current: current.id,
        }))
        return {
          type: "account",
          properties: {
            email: current.email,
            accountID: current.id,
          },
        }
      }
      return {
        type: "public",
        properties: {},
      }
    }
    const accounts = Object.keys(auth.data.account ?? {})
    if (accounts.length) {
      const user = await Database.use((tx) =>
        tx
          .select()
          .from(UserTable)
          .where(
            and(
              eq(UserTable.workspaceID, workspace),
              isNull(UserTable.timeDeleted),
              inArray(UserTable.accountID, accounts),
            ),
          )
          .limit(1)
          .execute()
          .then((x) => x[0]),
      )
      if (user) {
        await Database.use((tx) =>
          tx
            .update(UserTable)
            .set({ timeSeen: new Date() })
            .where(and(eq(UserTable.workspaceID, workspace), eq(UserTable.id, user.id))),
        )
        return {
          type: "user",
          properties: {
            userID: user.id,
            workspaceID: user.workspaceID,
            accountID: user.accountID,
            role: user.role,
          },
        }
      }
    }
    throw redirect("/auth/authorize")
  })()
  return evt.locals.actor
}
