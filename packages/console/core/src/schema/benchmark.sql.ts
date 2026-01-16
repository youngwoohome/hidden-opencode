import { index, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { id, timestamps } from "../drizzle/types"

export const BenchmarkTable = sqliteTable(
  "benchmark",
  {
    id: id(),
    ...timestamps,
    model: text("model", { length: 64 }).notNull(),
    agent: text("agent", { length: 64 }).notNull(),
    result: text("result").notNull(),
  },
  (table) => [primaryKey({ columns: [table.id] }), index("time_created").on(table.timeCreated)],
)
