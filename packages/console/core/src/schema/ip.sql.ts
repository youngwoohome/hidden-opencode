import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { timestamps } from "../drizzle/types"

export const IpTable = sqliteTable(
  "ip",
  {
    ip: text("ip", { length: 45 }).notNull(),
    ...timestamps,
    usage: integer("usage"),
  },
  (table) => [primaryKey({ columns: [table.ip] })],
)

export const IpRateLimitTable = sqliteTable(
  "ip_rate_limit",
  {
    ip: text("ip", { length: 45 }).notNull(),
    interval: text("interval", { length: 10 }).notNull(),
    count: integer("count").notNull(),
  },
  (table) => [primaryKey({ columns: [table.ip, table.interval] })],
)
