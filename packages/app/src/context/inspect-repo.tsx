import { createEffect, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { createSimpleContext } from "@opencode-ai/ui/context"

export type InspectRepo = {
  id: string
  name: string
  url: string
  ref?: string
}

const repoSlug = (url: string) => {
  const trimmed = url.replace(/\/+$/, "")
  const withoutProtocol = trimmed.replace(/^https?:\/\/(www\.)?/i, "")
  const github = withoutProtocol.replace(/^github\.com\//i, "")
  const withoutGit = github.replace(/\.git$/i, "")
  return withoutGit || url
}

const normalizeInspectRepo = (input: unknown): InspectRepo | null => {
  if (typeof input === "string") {
    const name = repoSlug(input)
    const id = `${input}`
    return { id, name, url: input }
  }
  if (!input || typeof input !== "object") return null
  const record = input as { id?: unknown; name?: unknown; url?: unknown; ref?: unknown }
  if (typeof record.url !== "string" || record.url.trim() === "") return null
  const url = record.url.trim()
  const ref = typeof record.ref === "string" && record.ref.trim() ? record.ref.trim() : undefined
  const name =
    typeof record.name === "string" && record.name.trim() ? record.name.trim() : `${repoSlug(url)}${ref ? `@${ref}` : ""}`
  const id =
    typeof record.id === "string" && record.id.trim()
      ? record.id.trim()
      : `${url}${ref ? `#${ref}` : ""}`
  return { id, name, url, ref }
}

const parseEnvRepos = () => {
  const repos: InspectRepo[] = []
  const raw = import.meta.env.VITE_INSPECT_REPOS
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const normalized = normalizeInspectRepo(item)
          if (normalized) repos.push(normalized)
        }
      }
    } catch {}
  }

  if (repos.length === 0) {
    const fallbackUrl = import.meta.env.VITE_INSPECT_REPO_URL
    if (fallbackUrl) {
      const normalized = normalizeInspectRepo({ url: fallbackUrl, ref: import.meta.env.VITE_INSPECT_REPO_REF })
      if (normalized) repos.push(normalized)
    }
  }

  return repos
}

const envRepos = parseEnvRepos()

export const { use: useInspectRepo, provider: InspectRepoProvider } = createSimpleContext({
  name: "InspectRepo",
  init: () => {
    const [store, setStore] = persisted(
      Persist.global("inspect-repos", ["inspect-repos.v1"]),
      createStore({
        items: [] as InspectRepo[],
        selectedId: "",
      }),
    )

    const userRepos = createMemo(() => {
      const normalized: InspectRepo[] = []
      for (const item of store.items) {
        const repo = normalizeInspectRepo(item)
        if (repo) normalized.push(repo)
      }
      return normalized
    })

    const userRepoIds = createMemo(() => new Set(userRepos().map((repo) => repo.id)))

    const repos = createMemo(() => {
      const merged = new Map<string, InspectRepo>()
      for (const repo of userRepos()) {
        merged.set(repo.id, repo)
      }
      for (const repo of envRepos) {
        if (!merged.has(repo.id)) merged.set(repo.id, repo)
      }
      return Array.from(merged.values())
    })

    const current = createMemo(() => {
      const list = repos()
      if (list.length === 0) return undefined
      const match = list.find((repo) => repo.id === store.selectedId)
      return match ?? list[0]
    })

    createEffect(() => {
      const repo = current()
      if (!repo) return
      if (store.selectedId !== repo.id) {
        setStore("selectedId", repo.id)
      }
    })

    const addRepo = (input: unknown) => {
      const repo = normalizeInspectRepo(input)
      if (!repo) return null
      setStore("items", (prev) => {
        const next = [repo, ...prev.filter((item) => item.id !== repo.id)]
        return next
      })
      setStore("selectedId", repo.id)
      return repo
    }

    const removeRepo = (id: string) => {
      setStore("items", (prev) => prev.filter((item) => item.id !== id))
      if (store.selectedId === id) {
        setStore("selectedId", "")
      }
    }

    const selectRepo = (id: string) => setStore("selectedId", id)

    return {
      repos,
      current,
      userRepoIds,
      addRepo,
      removeRepo,
      selectRepo,
      repoSlug,
    }
  },
})
