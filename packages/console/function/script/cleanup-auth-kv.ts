type KVListResult = {
  name: string
}

type KVListResponse = {
  success: boolean
  errors?: { message?: string }[]
  result: KVListResult[]
  result_info?: {
    cursor?: string
  }
}

const args = new Set(process.argv.slice(2))
const dryRun = args.has("--dry-run")

const argPrefix = (() => {
  const match = process.argv.find((arg) => arg.startsWith("--prefix="))
  if (match) return match.split("=").slice(1).join("=").trim()
  const idx = process.argv.indexOf("--prefix")
  if (idx >= 0) return process.argv[idx + 1]
  return undefined
})()

const defaultPrefixes = "signing:key,encryption:key"
const prefixes = (argPrefix || process.env.CLEANUP_PREFIXES || defaultPrefixes)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)

const accountId = process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID
const apiToken = process.env.CLOUDFLARE_API_TOKEN
const namespaceId = (() => {
  const raw = process.env.SST_RESOURCE_AuthStorage
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed?.namespaceId) return parsed.namespaceId as string
    } catch {}
  }
  return process.env.AUTH_STORAGE_NAMESPACE_ID
})()

if (!accountId || !apiToken || !namespaceId) {
  console.error("Missing env: CLOUDFLARE_DEFAULT_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, SST_RESOURCE_AuthStorage")
  process.exit(1)
}

if (!prefixes.length) {
  console.error("No prefixes provided")
  process.exit(1)
}

const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}`

async function listKeys(prefix: string) {
  const keys: string[] = []
  let cursor: string | undefined
  for (;;) {
    const params = new URLSearchParams({ prefix, limit: "1000" })
    if (cursor) params.set("cursor", cursor)
    const response = await fetch(`${baseUrl}/keys?${params.toString()}`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    })
    const data = (await response.json()) as KVListResponse
    if (!data.success) {
      const message = data.errors?.map((err) => err.message).filter(Boolean).join("; ") || "Unknown error"
      throw new Error(`KV list failed for prefix "${prefix}": ${message}`)
    }
    keys.push(...data.result.map((item) => item.name))
    const next = data.result_info?.cursor
    if (!next || next === cursor) break
    cursor = next
  }
  return keys
}

async function deleteKeys(names: string[]) {
  const chunkSize = 1000
  for (let i = 0; i < names.length; i += chunkSize) {
    const chunk = names.slice(i, i + chunkSize)
    if (dryRun) {
      console.log(`[dry-run] delete ${chunk.length} keys`)
      continue
    }
    const response = await fetch(`${baseUrl}/bulk`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(chunk),
    })
    const data = (await response.json()) as { success: boolean; errors?: { message?: string }[] }
    if (!data.success) {
      const message = data.errors?.map((err) => err.message).filter(Boolean).join("; ") || "Unknown error"
      throw new Error(`KV delete failed: ${message}`)
    }
    console.log(`deleted ${chunk.length} keys`)
  }
}

async function run() {
  for (const prefix of prefixes) {
    const keys = await listKeys(prefix)
    console.log(`prefix "${prefix}": ${keys.length} keys`)
    if (keys.length) await deleteKeys(keys)
  }
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
