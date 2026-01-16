import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { timestamps, ulid, utc, workspaceColumns } from "../drizzle/types"
import { workspaceIndexes } from "./workspace.sql"

export const BillingTable = sqliteTable(
  "billing",
  {
    ...workspaceColumns,
    ...timestamps,
    customerID: text("customer_id", { length: 255 }),
    paymentMethodID: text("payment_method_id", { length: 255 }),
    paymentMethodType: text("payment_method_type", { length: 32 }),
    paymentMethodLast4: text("payment_method_last4", { length: 4 }),
    balance: integer("balance").notNull(),
    monthlyLimit: integer("monthly_limit"),
    monthlyUsage: integer("monthly_usage"),
    timeMonthlyUsageUpdated: utc("time_monthly_usage_updated"),
    reload: integer("reload", { mode: "boolean" }),
    reloadTrigger: integer("reload_trigger"),
    reloadAmount: integer("reload_amount"),
    reloadError: text("reload_error", { length: 255 }),
    timeReloadError: utc("time_reload_error"),
    timeReloadLockedTill: utc("time_reload_locked_till"),
    subscriptionID: text("subscription_id", { length: 28 }),
    subscriptionCouponID: text("subscription_coupon_id", { length: 28 }),
  },
  (table) => [
    ...workspaceIndexes(table),
    uniqueIndex("global_customer_id").on(table.customerID),
    uniqueIndex("global_subscription_id").on(table.subscriptionID),
  ],
)

export const SubscriptionTable = sqliteTable(
  "subscription",
  {
    ...workspaceColumns,
    ...timestamps,
    userID: ulid("user_id").notNull(),
    rollingUsage: integer("rolling_usage"),
    fixedUsage: integer("fixed_usage"),
    timeRollingUpdated: utc("time_rolling_updated"),
    timeFixedUpdated: utc("time_fixed_updated"),
  },
  (table) => [...workspaceIndexes(table), uniqueIndex("workspace_user_id").on(table.workspaceID, table.userID)],
)

export const PaymentTable = sqliteTable(
  "payment",
  {
    ...workspaceColumns,
    ...timestamps,
    customerID: text("customer_id", { length: 255 }),
    invoiceID: text("invoice_id", { length: 255 }),
    paymentID: text("payment_id", { length: 255 }),
    amount: integer("amount").notNull(),
    timeRefunded: utc("time_refunded"),
    enrichment: text("enrichment", { mode: "json" }).$type<
      | {
          type: "subscription"
          couponID?: string
        }
      | {
          type: "credit"
        }
    >(),
  },
  (table) => [...workspaceIndexes(table)],
)

export const UsageTable = sqliteTable(
  "usage",
  {
    ...workspaceColumns,
    ...timestamps,
    model: text("model", { length: 255 }).notNull(),
    provider: text("provider", { length: 255 }).notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    reasoningTokens: integer("reasoning_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWrite5mTokens: integer("cache_write_5m_tokens"),
    cacheWrite1hTokens: integer("cache_write_1h_tokens"),
    cost: integer("cost").notNull(),
    keyID: ulid("key_id"),
    enrichment: text("enrichment", { mode: "json" }).$type<{
      plan: "sub"
    }>(),
  },
  (table) => [...workspaceIndexes(table), index("usage_time_created").on(table.workspaceID, table.timeCreated)],
)
