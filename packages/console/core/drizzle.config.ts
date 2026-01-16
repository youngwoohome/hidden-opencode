import { Resource } from "sst"
import { defineConfig } from "drizzle-kit"

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID
const token = process.env.CLOUDFLARE_API_TOKEN
const databaseId =
  process.env.CLOUDFLARE_DATABASE_ID ?? (Resource.Database as { databaseId?: string }).databaseId

if (!accountId || !token || !databaseId) {
  throw new Error(
    "CLOUDFLARE_ACCOUNT_ID (or CLOUDFLARE_DEFAULT_ACCOUNT_ID), CLOUDFLARE_API_TOKEN, and CLOUDFLARE_DATABASE_ID are required",
  )
}

export default defineConfig({
  out: "./migrations-d1/",
  strict: true,
  schema: ["./src/**/*.sql.ts"],
  verbose: true,
  dialect: "sqlite",
  dbCredentials: {
    accountId,
    databaseId,
    token,
  },
})
