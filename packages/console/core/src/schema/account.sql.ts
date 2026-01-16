import { primaryKey, sqliteTable } from "drizzle-orm/sqlite-core"
import { id, timestamps } from "../drizzle/types"

export const AccountTable = sqliteTable(
  "account",
  {
    id: id(),
    ...timestamps,
  },
  (table) => [primaryKey({ columns: [table.id] })],
)
