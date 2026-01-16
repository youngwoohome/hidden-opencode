import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { timestamps, workspaceColumns } from "../drizzle/types"
import { workspaceIndexes } from "./workspace.sql"

export const ModelTable = sqliteTable(
  "model",
  {
    ...workspaceColumns,
    ...timestamps,
    model: text("model", { length: 64 }).notNull(),
  },
  (table) => [...workspaceIndexes(table), uniqueIndex("model_workspace_model").on(table.workspaceID, table.model)],
)
