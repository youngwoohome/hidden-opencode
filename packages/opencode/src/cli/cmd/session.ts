import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { Session } from "../../session"
import { SessionSpawn } from "../../session/spawn"
import { bootstrap } from "../bootstrap"
import { UI } from "../ui"
import { Locale } from "../../util/locale"
import { Flag } from "../../flag/flag"
import { EOL } from "os"
import path from "path"

function pagerCmd(): string[] {
  const lessOptions = ["-R", "-S"]
  if (process.platform !== "win32") {
    return ["less", ...lessOptions]
  }

  // user could have less installed via other options
  const lessOnPath = Bun.which("less")
  if (lessOnPath) {
    if (Bun.file(lessOnPath).size) return [lessOnPath, ...lessOptions]
  }

  if (Flag.OPENCODE_GIT_BASH_PATH) {
    const less = path.join(Flag.OPENCODE_GIT_BASH_PATH, "..", "..", "usr", "bin", "less.exe")
    if (Bun.file(less).size) return [less, ...lessOptions]
  }

  const git = Bun.which("git")
  if (git) {
    const less = path.join(git, "..", "..", "usr", "bin", "less.exe")
    if (Bun.file(less).size) return [less, ...lessOptions]
  }

  // Fall back to Windows built-in more (via cmd.exe)
  return ["cmd", "/c", "more"]
}

export const SessionCommand = cmd({
  command: "session",
  describe: "manage sessions",
  builder: (yargs: Argv) =>
    yargs.command(SessionListCommand).command(SessionSpawnCommand).command(SessionJoinCommand).demandCommand(),
  async handler() {},
})

export const SessionListCommand = cmd({
  command: "list",
  describe: "list sessions",
  builder: (yargs: Argv) => {
    return yargs
      .option("max-count", {
        alias: "n",
        describe: "limit to N most recent sessions",
        type: "number",
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const sessions = []
      for await (const session of Session.list()) {
        if (!session.parentID) {
          sessions.push(session)
        }
      }

      sessions.sort((a, b) => b.time.updated - a.time.updated)

      const limitedSessions = args.maxCount ? sessions.slice(0, args.maxCount) : sessions

      if (limitedSessions.length === 0) {
        return
      }

      let output: string
      if (args.format === "json") {
        output = formatSessionJSON(limitedSessions)
      } else {
        output = formatSessionTable(limitedSessions)
      }

      const shouldPaginate = process.stdout.isTTY && !args.maxCount && args.format === "table"

      if (shouldPaginate) {
        const proc = Bun.spawn({
          cmd: pagerCmd(),
          stdin: "pipe",
          stdout: "inherit",
          stderr: "inherit",
        })

        proc.stdin.write(output)
        proc.stdin.end()
        await proc.exited
      } else {
        console.log(output)
      }
    })
  },
})

export const SessionSpawnCommand = cmd({
  command: "spawn <parent>",
  describe: "spawn a child session",
  builder: (yargs: Argv) => {
    return yargs
      .positional("parent", {
        describe: "parent session id",
        type: "string",
        demandOption: true,
      })
      .option("title", {
        describe: "child session title",
        type: "string",
      })
      .option("directory", {
        describe: "child working directory (defaults to current directory)",
        type: "string",
      })
      .option("worktree", {
        describe: "spawn child in a dedicated git worktree (local isolation)",
        type: "boolean",
        default: false,
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["json", "id"],
        default: "id",
      })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const child = await SessionSpawn.spawn({
        parentSessionID: args.parent as string,
        title: args.title as string | undefined,
        directory: args.directory as string | undefined,
        useWorktree: args.worktree === true,
      })
      if (args.format === "json") {
        console.log(JSON.stringify(child, null, 2))
      } else {
        console.log(child.id)
      }
    })
  },
})

export const SessionJoinCommand = cmd({
  command: "join <parent> <child>",
  describe: "join a child session into a parent (writes synthetic summary message + event logs)",
  builder: (yargs: Argv) => {
    return yargs
      .positional("parent", {
        describe: "parent session id",
        type: "string",
        demandOption: true,
      })
      .positional("child", {
        describe: "child session id",
        type: "string",
        demandOption: true,
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["text", "json"],
        default: "text",
      })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const result = await SessionSpawn.join({
        parentSessionID: args.parent as string,
        childSessionID: args.child as string,
      })
      if (args.format === "json") {
        console.log(JSON.stringify(result, null, 2))
      } else {
        console.log(result.summary)
      }
    })
  },
})

function formatSessionTable(sessions: Session.Info[]): string {
  const lines: string[] = []

  const maxIdWidth = Math.max(20, ...sessions.map((s) => s.id.length))
  const maxTitleWidth = Math.max(25, ...sessions.map((s) => s.title.length))

  const header = `Session ID${" ".repeat(maxIdWidth - 10)}  Title${" ".repeat(maxTitleWidth - 5)}  Updated`
  lines.push(header)
  lines.push("─".repeat(header.length))
  for (const session of sessions) {
    const truncatedTitle = Locale.truncate(session.title, maxTitleWidth)
    const timeStr = Locale.todayTimeOrDateTime(session.time.updated)
    const line = `${session.id.padEnd(maxIdWidth)}  ${truncatedTitle.padEnd(maxTitleWidth)}  ${timeStr}`
    lines.push(line)
  }

  return lines.join(EOL)
}

function formatSessionJSON(sessions: Session.Info[]): string {
  const jsonData = sessions.map((session) => ({
    id: session.id,
    title: session.title,
    updated: session.time.updated,
    created: session.time.created,
    projectId: session.projectID,
    directory: session.directory,
  }))
  return JSON.stringify(jsonData, null, 2)
}
