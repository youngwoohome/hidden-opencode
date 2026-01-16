import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { timestamps, ulid, utc, workspaceColumns } from "../drizzle/types"
import { workspaceIndexes } from "./workspace.sql"

export const KeyTable = sqliteTable(
  "key",
  {
    ...workspaceColumns,
    ...timestamps,
    name: text("name", { length: 255 }).notNull(),
    key: text("key", { length: 255 }).notNull(),
    userID: ulid("user_id").notNull(),
    timeUsed: utc("time_used"),
  },
  (table) => [...workspaceIndexes(table), uniqueIndex("global_key").on(table.key)],
)
