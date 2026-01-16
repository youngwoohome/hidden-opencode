import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { timestamps, ulid, utc, workspaceColumns } from "../drizzle/types"
import { workspaceIndexes } from "./workspace.sql"

export const UserRole = ["admin", "member"] as const

export const UserTable = sqliteTable(
  "user",
  {
    ...workspaceColumns,
    ...timestamps,
    accountID: ulid("account_id"),
    email: text("email", { length: 255 }),
    name: text("name", { length: 255 }).notNull(),
    timeSeen: utc("time_seen"),
    color: integer("color"),
    role: text("role", { enum: UserRole }).notNull(),
    monthlyLimit: integer("monthly_limit"),
    monthlyUsage: integer("monthly_usage"),
    timeMonthlyUsageUpdated: utc("time_monthly_usage_updated"),
  },
  (table) => [
    ...workspaceIndexes(table),
    uniqueIndex("user_account_id").on(table.workspaceID, table.accountID),
    uniqueIndex("user_email").on(table.workspaceID, table.email),
    index("global_account_id").on(table.accountID),
    index("global_email").on(table.email),
  ],
)
