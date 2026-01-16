import { primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { id, timestamps, ulid } from "../drizzle/types"

export const GithubTokenTable = sqliteTable(
  "github_token",
  {
    id: id(),
    ...timestamps,
    accountID: ulid("account_id").notNull(),
    accessToken: text("access_token").notNull(),
    scope: text("scope"),
    tokenType: text("token_type", { length: 32 }),
  },
  (table) => [primaryKey({ columns: [table.id] }), uniqueIndex("account_id").on(table.accountID)],
)
