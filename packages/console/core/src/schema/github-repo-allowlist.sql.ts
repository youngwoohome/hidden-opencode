import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { timestamps, workspaceColumns } from "../drizzle/types"
import { workspaceIndexes } from "./workspace.sql"

export const GithubRepoAllowlistTable = sqliteTable(
  "github_repo_allowlist",
  {
    ...workspaceColumns,
    ...timestamps,
    owner: text("owner", { length: 255 }).notNull(),
    repo: text("repo", { length: 255 }).notNull(),
    addedByAccountID: text("added_by_account_id", { length: 30 }),
  },
  (table) => [
    ...workspaceIndexes(table),
    uniqueIndex("workspace_repo").on(table.workspaceID, table.owner, table.repo),
  ],
)
