import { index, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { id, timestamps, ulid } from "../drizzle/types"

export const AuthProvider = ["email", "github", "google"] as const

export const AuthTable = sqliteTable(
  "auth",
  {
    id: id(),
    ...timestamps,
    provider: text("provider", { enum: AuthProvider }).notNull(),
    subject: text("subject", { length: 255 }).notNull(),
    accountID: ulid("account_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex("provider").on(table.provider, table.subject),
    index("account_id").on(table.accountID),
  ],
)
