import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { Instance } from "@/project/instance"
import { $ } from "bun"
import * as prompts from "@clack/prompts"

function safeText(result: { text: () => string }) {
  try {
    return result.text().trim()
  } catch {
    return ""
  }
}

export const PrCreateCommand = cmd({
  command: "pr-create",
  describe: "create a PR for the current git branch (dry-run by default)",
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
      .option("update-base", {
        describe: "update base branch with git pull --ff-only before creating PR",
        type: "boolean",
        default: false,
      })
      .option("no-verify", {
        describe: "add --no-verify to git commit/push in the plan",
        type: "boolean",
        default: true,
      })
      .option("yes", {
        describe: "skip confirmation prompts (non-dry-run only)",
        type: "boolean",
        default: false,
      })
      .option("watch", {
        describe: "after PR creation, poll and print GitHub status checks",
        type: "boolean",
        default: false,
      })
      .option("watch-interval", {
        describe: "watch polling interval in seconds",
        type: "number",
        default: 10,
      })
      .option("watch-timeout", {
        describe: "watch timeout in seconds",
        type: "number",
        default: 900,
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

        const isDryRun = args.dryRun === true
        UI.println(UI.Style.TEXT_INFO_BOLD + `PR create (${isDryRun ? "dry-run plan" : "execute"})` + UI.Style.TEXT_NORMAL)
        UI.println(`- branch: ${branch}`)
        UI.println(`- base: ${base}`)
        UI.println(`- remote: ${remote}`)
        UI.println(`- update base: ${args.updateBase ? "yes" : "no"}`)
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
        const updateBase = args.updateBase === true
        const yes = args.yes === true
        const watch = args.watch === true
        const watchIntervalSec = Number(args.watchInterval)
        const watchTimeoutSec = Number(args.watchTimeout)

        UI.println()
        UI.println(UI.Style.TEXT_HIGHLIGHT_BOLD + "Suggested commands" + UI.Style.TEXT_NORMAL)
        UI.println(`# 1) Ensure base is up to date${updateBase ? "" : " (optional)"}`)
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
        UI.println(
          `gh pr create ${draftFlag}--base ${base} --head ${branch} --title ${JSON.stringify(title)} --body ${JSON.stringify(body)}`,
        )

        if (isDryRun) return

        UI.println()
        UI.println(UI.Style.TEXT_WARNING_BOLD + "Executing... (this will run git/gh commands)" + UI.Style.TEXT_NORMAL)

        if (!yes) {
          prompts.intro("PR create (execute)")
          const proceed = await prompts.confirm({
            message: `Proceed to push branch "${branch}" and create PR against "${base}"?`,
            initialValue: false,
          })
          if (prompts.isCancel(proceed) || proceed === false) {
            prompts.outro("Cancelled")
            process.exit(1)
          }
          prompts.outro("Proceeding")
        }

        // Validate tools available
        {
          const ghVer = await $`gh --version`.nothrow()
          if (ghVer.exitCode !== 0) {
            UI.error("gh CLI is required. Please install GitHub CLI: https://cli.github.com/")
            process.exit(1)
          }
          const ghAuth = await $`gh auth status`.nothrow()
          if (ghAuth.exitCode !== 0) {
            UI.error("gh CLI is not authenticated. Please run: gh auth login")
            process.exit(1)
          }
          const remoteCheck = await $`git remote get-url ${remote}`.nothrow()
          if (remoteCheck.exitCode !== 0) {
            UI.error(`Git remote "${remote}" not found`)
            process.exit(1)
          }
        }

        // Optionally update base branch (ff-only) to reduce PR drift.
        if (updateBase) {
          const current = branch
          const checkoutBase = await $`git checkout ${base}`.nothrow()
          if (checkoutBase.exitCode !== 0) {
            UI.error(`Failed to checkout base branch "${base}"`)
            process.exit(1)
          }
          const pullBase = await $`git pull --ff-only ${remote} ${base}`.nothrow()
          if (pullBase.exitCode !== 0) {
            UI.error(`Failed to update base branch "${base}" (ff-only). Please resolve manually.`)
            process.exit(1)
          }
          const checkoutBack = await $`git checkout ${current}`.nothrow()
          if (checkoutBack.exitCode !== 0) {
            UI.error(`Failed to switch back to branch "${current}"`)
            process.exit(1)
          }
        }

        // Commit (if dirty)
        {
          const status = safeText(await $`git status --porcelain=v1`.nothrow())
          if (status) {
            const addRes = await $`git add -A`.nothrow()
            if (addRes.exitCode !== 0) {
              UI.error("Failed to git add")
              process.exit(1)
            }
            const commitCmd = args.noVerify ? $`git commit --no-verify -m ${title}` : $`git commit -m ${title}`
            const commitRes = await commitCmd.nothrow()
            if (commitRes.exitCode !== 0) {
              // If there was nothing to commit after add, treat as non-fatal
              const stderr = safeText({ text: () => commitRes.stderr.toString() })
              const stdout = safeText({ text: () => commitRes.stdout.toString() })
              const combined = `${stdout}\n${stderr}`.toLowerCase()
              if (!combined.includes("nothing to commit")) {
                UI.error("Failed to git commit")
                process.exit(1)
              }
            }
          }
        }

        // Push branch
        {
          const pushCmd = args.noVerify
            ? $`git push --no-verify -u ${remote} ${branch}`
            : $`git push -u ${remote} ${branch}`
          const pushRes = await pushCmd.nothrow()
          if (pushRes.exitCode !== 0) {
            UI.error("Failed to git push")
            process.exit(1)
          }
        }

        // Create (or reuse) PR
        {
          let prUrl: string | undefined
          let prNumber: number | undefined

          // Try to detect existing PR first (avoid create failure).
          const existing = await $`gh pr view --head ${branch} --json url,number`.nothrow()
          if (existing.exitCode === 0) {
            const txt = safeText(existing)
            if (txt) {
              try {
                const parsed = JSON.parse(txt) as { url?: string; number?: number }
                prUrl = parsed.url
                prNumber = parsed.number
              } catch {
                // ignore and continue
              }
            }
          }

          if (prUrl) {
            UI.println()
            UI.println(UI.Style.TEXT_SUCCESS_BOLD + `PR already exists: ${prUrl}` + UI.Style.TEXT_NORMAL)
          } else {
            const createRes = args.draft
              ? await $`gh pr create --draft --base ${base} --head ${branch} --title ${title} --body ${body}`.nothrow()
              : await $`gh pr create --base ${base} --head ${branch} --title ${title} --body ${body}`.nothrow()
            if (createRes.exitCode !== 0) {
              UI.error("Failed to create PR with gh")
              process.exit(1)
            }
            const out = safeText(createRes)
            UI.println()
            UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Created PR: ${out || "(created)"}` + UI.Style.TEXT_NORMAL)

            // Best-effort: resolve PR URL/number for watch mode.
            const view = await $`gh pr view --head ${branch} --json url,number`.nothrow()
            if (view.exitCode === 0) {
              const txt = safeText(view)
              if (txt) {
                try {
                  const parsed = JSON.parse(txt) as { url?: string; number?: number }
                  prUrl = prUrl ?? parsed.url
                  prNumber = prNumber ?? parsed.number
                } catch {
                  // ignore
                }
              }
            }
          }

          if (watch) {
            if (!Number.isFinite(watchIntervalSec) || watchIntervalSec <= 0) {
              UI.error("--watch-interval must be a positive number (seconds)")
              process.exit(1)
            }
            if (!Number.isFinite(watchTimeoutSec) || watchTimeoutSec <= 0) {
              UI.error("--watch-timeout must be a positive number (seconds)")
              process.exit(1)
            }

            const target = prUrl ?? (prNumber ? String(prNumber) : branch)
            UI.println()
            UI.println(UI.Style.TEXT_INFO_BOLD + `Watching status checks for: ${target}` + UI.Style.TEXT_NORMAL)

            const deadline = Date.now() + watchTimeoutSec * 1000
            let lastSummary = ""
            let lastDigest = ""

            while (Date.now() < deadline) {
              const res = await $`gh pr view ${target} --json statusCheckRollup`.nothrow()
              if (res.exitCode !== 0) {
                UI.error("Failed to fetch PR status checks with gh")
                process.exit(1)
              }

              const txt = safeText(res)
              let rollup: any[] = []
              try {
                const parsed = JSON.parse(txt) as { statusCheckRollup?: any[] }
                rollup = Array.isArray(parsed.statusCheckRollup) ? parsed.statusCheckRollup : []
              } catch {
                rollup = []
              }

              const checks = rollup.map((c) => {
                const state = String(c.state ?? c.conclusion ?? "UNKNOWN").toUpperCase()
                const name = String(c.name ?? c.context ?? c.workflowName ?? c.title ?? "check")
                const url = c.detailsUrl ?? c.targetUrl ?? c.url
                return { state, name, url }
              })

              const states = checks.map((c) => c.state)
              const total = rollup.length
              const pending = states.filter((s) => ["PENDING", "IN_PROGRESS", "QUEUED", "REQUESTED", "WAITING"].includes(s))
                .length
              const success = states.filter((s) => ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(s)).length
              const failure = states.filter((s) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(s))
                .length

              const summary = `checks: ${success}/${total} success, ${pending} pending, ${failure} failing`
              if (summary !== lastSummary) {
                UI.println(summary)
                lastSummary = summary
              }

              // Print per-check transitions without spamming every poll.
              const digest = checks
                .toSorted((a, b) => a.name.localeCompare(b.name))
                .map((c) => `${c.state}:${c.name}`)
                .join("|")
              if (digest && digest !== lastDigest) {
                lastDigest = digest
                const interesting = checks
                  .filter((c) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(c.state))
                  .toSorted((a, b) => a.name.localeCompare(b.name))
                if (interesting.length > 0) {
                  UI.println(UI.Style.TEXT_WARNING_BOLD + "Failing checks:" + UI.Style.TEXT_NORMAL)
                  for (const c of interesting.slice(0, 10)) {
                    UI.println(`- ${c.state.padEnd(10)} ${c.name}${c.url ? " (" + c.url + ")" : ""}`)
                  }
                }
              }

              if (total > 0 && pending === 0) {
                UI.println(UI.Style.TEXT_SUCCESS_BOLD + "Status checks completed." + UI.Style.TEXT_NORMAL)
                break
              }

              await Bun.sleep(watchIntervalSec * 1000)
            }

            if (Date.now() >= deadline) {
              UI.println(UI.Style.TEXT_WARNING_BOLD + "Watch timed out." + UI.Style.TEXT_NORMAL)
            }
          }
        }
      },
    })
  },
})

