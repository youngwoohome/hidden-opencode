import { primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { timestamps, ulid } from "../drizzle/types"

export const WorkspaceTable = sqliteTable(
  "workspace",
  {
    id: ulid("id").notNull().primaryKey(),
    slug: text("slug", { length: 255 }),
    name: text("name", { length: 255 }).notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("slug").on(table.slug)],
)

export function workspaceIndexes(table: any) {
  return [
    primaryKey({
      columns: [table.workspaceID, table.id],
    }),
  ]
}
