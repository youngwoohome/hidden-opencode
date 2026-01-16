import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { timestamps, workspaceColumns } from "../drizzle/types"
import { workspaceIndexes } from "./workspace.sql"

export const ProviderTable = sqliteTable(
  "provider",
  {
    ...workspaceColumns,
    ...timestamps,
    provider: text("provider", { length: 64 }).notNull(),
    credentials: text("credentials").notNull(),
  },
  (table) => [...workspaceIndexes(table), uniqueIndex("workspace_provider").on(table.workspaceID, table.provider)],
)
