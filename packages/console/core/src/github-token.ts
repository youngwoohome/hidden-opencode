import { z } from "zod"
import { fn } from "./util/fn"
import { and, Database, eq, isNull } from "./drizzle"
import { Identifier } from "./identifier"
import { GithubTokenTable } from "./schema/github-token.sql"

export namespace GithubToken {
  export const upsert = fn(
    z.object({
      accountID: z.string(),
      accessToken: z.string().min(1),
      scope: z.string().optional(),
      tokenType: z.string().optional(),
    }),
    async (input) => {
      await Database.use((tx) =>
        tx
          .insert(GithubTokenTable)
          .values({
            id: Identifier.create("githubToken"),
            accountID: input.accountID,
            accessToken: input.accessToken,
            scope: input.scope ?? null,
            tokenType: input.tokenType ?? null,
          })
          .onConflictDoUpdate({
            target: [GithubTokenTable.accountID],
            set: {
              accessToken: input.accessToken,
              scope: input.scope ?? null,
              tokenType: input.tokenType ?? null,
              timeDeleted: null,
            },
          }),
      )
    },
  )

  export const get = fn(z.object({ accountID: z.string() }), async (input) =>
    Database.use((tx) =>
      tx
        .select()
        .from(GithubTokenTable)
        .where(and(eq(GithubTokenTable.accountID, input.accountID), isNull(GithubTokenTable.timeDeleted)))
        .limit(1)
        .then((rows) => rows[0]),
    ),
  )
}
