import { Resource } from "sst"
import { defineConfig } from "drizzle-kit"

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID
const token = process.env.CLOUDFLARE_API_TOKEN

if (!accountId || !token) {
  throw new Error("CLOUDFLARE_ACCOUNT_ID (or CLOUDFLARE_DEFAULT_ACCOUNT_ID) and CLOUDFLARE_API_TOKEN are required")
}

export default defineConfig({
  out: "./migrations-d1/",
  strict: true,
  schema: ["./src/**/*.sql.ts"],
  verbose: true,
  dialect: "sqlite",
  dbCredentials: {
    driver: "d1-http",
    accountId,
    databaseId: Resource.Database.databaseId,
    token,
  },
})
