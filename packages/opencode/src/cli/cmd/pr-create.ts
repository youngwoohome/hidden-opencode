import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { Instance } from "@/project/instance"
import { $ } from "bun"

function safeText(result: { text: () => string }) {
  try {
    return result.text().trim()
  } catch {
    return ""
  }
}

export const PrCreateCommand = cmd({
  command: "pr-create",
  describe: "prepare a PR creation plan (dry-run) for the current git branch",
  builder: (yargs: Argv) =>
    yargs
      .option("base", {
        describe: "base branch to target",
        type: "string",
        default: "dev",
      })
      .option("remote", {
        describe: "git remote name",
        type: "string",
        default: "origin",
      })
      .option("title", {
        describe: "PR title",
        type: "string",
      })
      .option("body", {
        describe: "PR body (markdown)",
        type: "string",
      })
      .option("draft", {
        describe: "create as draft (shown in plan)",
        type: "boolean",
        default: false,
      })
      .option("no-verify", {
        describe: "add --no-verify to git commit/push in the plan",
        type: "boolean",
        default: true,
      })
      .option("dry-run", {
        describe: "only print the plan; do not run any git/gh commands",
        type: "boolean",
        default: true,
      }),
  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        const project = Instance.project
        if (project.vcs !== "git") {
          UI.error("Could not find git repository. Please run this command from a git repository.")
          process.exit(1)
        }

        const base = String(args.base)
        const remote = String(args.remote)

        const branchRes = await $`git rev-parse --abbrev-ref HEAD`.nothrow()
        const branch = safeText(branchRes)
        if (!branch) {
          UI.error("Failed to detect current branch")
          process.exit(1)
        }

        const statusRes = await $`git status --porcelain=v1`.nothrow()
        const dirty = safeText(statusRes)

        const diffStatRes = await $`git diff --stat`.nothrow()
        const diffStat = safeText(diffStatRes)

        const title = (args.title ? String(args.title) : `chore: ${branch}`).trim()
        const body = (args.body ? String(args.body) : "").trim()

        UI.println(UI.Style.TEXT_INFO_BOLD + "PR create (dry-run plan)" + UI.Style.TEXT_NORMAL)
        UI.println(`- branch: ${branch}`)
        UI.println(`- base: ${base}`)
        UI.println(`- remote: ${remote}`)
        if (dirty) {
          UI.println(UI.Style.TEXT_WARNING + "- working tree: dirty" + UI.Style.TEXT_NORMAL)
        } else {
          UI.println(UI.Style.TEXT_SUCCESS + "- working tree: clean" + UI.Style.TEXT_NORMAL)
        }
        if (diffStat) {
          UI.println()
          UI.println(UI.Style.TEXT_DIM_BOLD + "diff --stat" + UI.Style.TEXT_NORMAL)
          UI.println(diffStat)
        }

        const noVerify = args.noVerify ? " --no-verify" : ""
        const draftFlag = args.draft ? "--draft " : ""

        UI.println()
        UI.println(UI.Style.TEXT_HIGHLIGHT_BOLD + "Suggested commands" + UI.Style.TEXT_NORMAL)
        UI.println(`# 1) Ensure base is up to date`)
        UI.println(`git checkout ${base}`)
        UI.println(`git pull --ff-only ${remote} ${base}`)
        UI.println()
        UI.println(`# 2) Switch back to your branch`)
        UI.println(`git checkout ${branch}`)
        UI.println()
        if (dirty) {
          UI.println(`# 3) Commit changes`)
          UI.println(`git add -A`)
          UI.println(`git commit${noVerify} -m ${JSON.stringify(title)}`)
          UI.println()
        } else {
          UI.println(`# 3) Commit changes (skipped: clean working tree)`)
          UI.println()
        }
        UI.println(`# 4) Push branch`)
        UI.println(`git push${noVerify} -u ${remote} ${branch}`)
        UI.println()
        UI.println(`# 5) Create PR (gh CLI)`)
        UI.println(`gh pr create ${draftFlag}--base ${base} --head ${branch} --title ${JSON.stringify(title)}${body ? " --body " + JSON.stringify(body) : ""}`)

        if (args.dryRun !== true) {
          UI.println()
          UI.println(UI.Style.TEXT_WARNING_BOLD + "Non-dry-run mode is not implemented yet." + UI.Style.TEXT_NORMAL)
        }
      },
    })
  },
})

