import { z } from "zod"
import { fn } from "./util/fn"
import { Actor } from "./actor"
import { and, Database, eq, isNull, sql } from "./drizzle"
import { Identifier } from "./identifier"
import { GithubRepoAllowlistTable } from "./schema/github-repo-allowlist.sql"

function normalize(value: string) {
  return value.trim().toLowerCase()
}

export namespace GithubRepoAllowlist {
  export const list = fn(z.void(), () =>
    Database.use((tx) =>
      tx
        .select()
        .from(GithubRepoAllowlistTable)
        .where(and(eq(GithubRepoAllowlistTable.workspaceID, Actor.workspace()), isNull(GithubRepoAllowlistTable.timeDeleted)))
        .orderBy(sql`${GithubRepoAllowlistTable.owner} ASC, ${GithubRepoAllowlistTable.repo} ASC`),
    ),
  )

  export const add = fn(
    z.object({
      owner: z.string().min(1).max(255),
      repo: z.string().min(1).max(255),
    }),
    async (input) => {
      Actor.assertAdmin()
      const owner = normalize(input.owner)
      const repo = normalize(input.repo)
      await Database.use((tx) =>
        tx
          .insert(GithubRepoAllowlistTable)
          .values({
            id: Identifier.create("githubRepoAllowlist"),
            workspaceID: Actor.workspace(),
            owner,
            repo,
            addedByAccountID: Actor.account(),
          })
          .onConflictDoUpdate({
            target: [GithubRepoAllowlistTable.workspaceID, GithubRepoAllowlistTable.owner, GithubRepoAllowlistTable.repo],
            set: {
              timeDeleted: null,
              addedByAccountID: Actor.account(),
            },
          }),
      )
    },
  )

  export const remove = fn(
    z.object({
      owner: z.string().min(1).max(255),
      repo: z.string().min(1).max(255),
    }),
    async (input) => {
      Actor.assertAdmin()
      const owner = normalize(input.owner)
      const repo = normalize(input.repo)
      await Database.use((tx) =>
        tx
          .update(GithubRepoAllowlistTable)
          .set({ timeDeleted: new Date() })
          .where(
            and(
              eq(GithubRepoAllowlistTable.workspaceID, Actor.workspace()),
              eq(GithubRepoAllowlistTable.owner, owner),
              eq(GithubRepoAllowlistTable.repo, repo),
            ),
          ),
      )
    },
  )

  export const isAllowed = fn(
    z.object({
      workspaceID: z.string(),
      owner: z.string().min(1).max(255),
      repo: z.string().min(1).max(255),
    }),
    async (input) => {
      const owner = normalize(input.owner)
      const repo = normalize(input.repo)
      return Database.use(async (tx) => {
        const any = await tx
          .select()
          .from(GithubRepoAllowlistTable)
          .where(
            and(eq(GithubRepoAllowlistTable.workspaceID, input.workspaceID), isNull(GithubRepoAllowlistTable.timeDeleted)),
          )
          .limit(1)
          .then((rows) => rows[0])
        if (!any) return true
        const match = await tx
          .select()
          .from(GithubRepoAllowlistTable)
          .where(
            and(
              eq(GithubRepoAllowlistTable.workspaceID, input.workspaceID),
              eq(GithubRepoAllowlistTable.owner, owner),
              eq(GithubRepoAllowlistTable.repo, repo),
              isNull(GithubRepoAllowlistTable.timeDeleted),
            ),
          )
          .limit(1)
          .then((rows) => rows[0])
        return Boolean(match)
      })
    },
  )
}
