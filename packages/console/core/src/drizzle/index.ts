import { drizzle } from "drizzle-orm/d1"
import { Resource } from "@opencode-ai/console-resource"
export * from "drizzle-orm"

import { SQLiteTransaction, type SQLiteTransactionConfig } from "drizzle-orm/sqlite-core"
import type { ExtractTablesWithRelations } from "drizzle-orm"
import { Context } from "../context"
import { memo } from "../util/memo"

export namespace Database {
  export type Transaction = SQLiteTransaction<
    "async",
    unknown,
    Record<string, never>,
    ExtractTablesWithRelations<Record<string, never>>
  >

  const client = memo(() => {
    const db = drizzle(Resource.Database, {})
    return db
  })

  export type TxOrDb = Transaction | ReturnType<typeof client>

  const TransactionContext = Context.create<{
    tx: TxOrDb
    effects: (() => void | Promise<void>)[]
  }>()
  const supportsSqlTransactions = false // D1 rejects BEGIN/SAVEPOINT; keep operations non-transactional.

  export async function use<T>(callback: (trx: TxOrDb) => Promise<T>) {
    try {
      const { tx } = TransactionContext.use()
      return supportsSqlTransactions ? tx.transaction(callback) : callback(tx)
    } catch (err) {
      if (err instanceof Context.NotFound) {
        const effects: (() => void | Promise<void>)[] = []
        const result = await TransactionContext.provide(
          {
            effects,
            tx: client(),
          },
          () => callback(client()),
        )
        await Promise.all(effects.map((x) => x()))
        return result
      }
      throw err
    }
  }
  export async function fn<Input, T>(callback: (input: Input, trx: TxOrDb) => Promise<T>) {
    return (input: Input) => use(async (tx) => callback(input, tx))
  }

  export async function effect(effect: () => any | Promise<any>) {
    try {
      const { effects } = TransactionContext.use()
      effects.push(effect)
    } catch {
      await effect()
    }
  }

  export async function transaction<T>(callback: (tx: TxOrDb) => Promise<T>, config?: SQLiteTransactionConfig) {
    try {
      const { tx } = TransactionContext.use()
      return callback(tx)
    } catch (err) {
      if (err instanceof Context.NotFound) {
        const effects: (() => void | Promise<void>)[] = []
        const result = supportsSqlTransactions
          ? await client().transaction(async (tx) => {
              return TransactionContext.provide({ tx, effects }, () => callback(tx))
            }, config)
          : await TransactionContext.provide({ tx: client(), effects }, () => callback(client()))
        await Promise.all(effects.map((x) => x()))
        return result
      }
      throw err
    }
  }
}
