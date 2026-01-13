import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { $ } from "bun"
import * as prompts from "@clack/prompts"
import { Sandbox } from "@/sandbox/types"
import { SandboxProviders } from "@/sandbox"

function safeText(result: { text: () => string }) {
  try {
    return result.text().trim()
  } catch {
    return ""
  }
}

async function detectGitRemoteAndRef(cwd: string): Promise<{ url: string; ref: string } | undefined> {
  const urlRes = await $`git remote get-url origin`.quiet().nothrow().cwd(cwd)
  if (urlRes.exitCode !== 0) return
  const url = safeText(urlRes)
  if (!url) return

  // Prefer current commit sha for reproducibility.
  const shaRes = await $`git rev-parse HEAD`.quiet().nothrow().cwd(cwd)
  const sha = safeText(shaRes)
  if (!sha) return
  return { url, ref: sha }
}

export const SandboxCommand = cmd({
  command: "sandbox",
  describe: "manage remote sandboxes (Modal/others)",
  builder: (yargs: Argv) =>
    yargs
      .command(SandboxCreateCommand)
      .command(SandboxStopCommand)
      .command(SandboxSnapshotCommand)
      .command(SandboxRestoreCommand)
      .demandCommand(),
  async handler() {},
})

export const SandboxCreateCommand = cmd({
  command: "create",
  describe: "create a sandbox and print connection info",
  builder: (yargs: Argv) =>
    yargs
      .option("provider", {
        describe: "sandbox provider (e.g., modal, fake)",
        type: "string",
        default: process.env.OPENCODE_SANDBOX_PROVIDER ?? "modal",
      })
      .option("repo", {
        describe: "git repo url (defaults to origin remote)",
        type: "string",
      })
      .option("ref", {
        describe: "git ref (branch/tag/sha). Defaults to current HEAD sha.",
        type: "string",
      })
      .option("name", {
        describe: "human-readable sandbox name (best-effort)",
        type: "string",
      })
      .option("ttl", {
        describe: "hard ttl seconds (provider best-effort)",
        type: "number",
        default: process.env.OPENCODE_SANDBOX_TTL_SECONDS ? Number(process.env.OPENCODE_SANDBOX_TTL_SECONDS) : undefined,
      })
      .option("idle", {
        describe: "idle timeout seconds (provider best-effort)",
        type: "number",
        default: process.env.OPENCODE_SANDBOX_IDLE_SECONDS ? Number(process.env.OPENCODE_SANDBOX_IDLE_SECONDS) : undefined,
      })
      .option("cpu", {
        describe: "cpu units (provider-specific)",
        type: "number",
        default: process.env.OPENCODE_SANDBOX_CPU ? Number(process.env.OPENCODE_SANDBOX_CPU) : undefined,
      })
      .option("mem", {
        describe: "memory in MB",
        type: "number",
        default: process.env.OPENCODE_SANDBOX_MEMORY_MB ? Number(process.env.OPENCODE_SANDBOX_MEMORY_MB) : undefined,
      })
      .option("disk", {
        describe: "disk in GB",
        type: "number",
        default: process.env.OPENCODE_SANDBOX_DISK_GB ? Number(process.env.OPENCODE_SANDBOX_DISK_GB) : undefined,
      })
      .option("env", {
        describe: "extra environment variables (KEY=VALUE). repeatable",
        type: "string",
        array: true,
      })
      .option("url", {
        describe: "known server base URL (stored as OPENCODE_SANDBOX_URL for providers that need it)",
        type: "string",
      })
      .option("yes", {
        describe: "skip confirmation prompt",
        type: "boolean",
        default: false,
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["text", "json"],
        default: "text",
      }),
  handler: async (args) => {
    const cwd = process.cwd()
    const detected = await detectGitRemoteAndRef(cwd)
    const repoUrl = (args.repo ? String(args.repo) : detected?.url)?.trim()
    const ref = (args.ref ? String(args.ref) : detected?.ref)?.trim()
    if (!repoUrl || !ref) {
      console.error("Could not infer repo/ref. Provide --repo and --ref (or run inside a git repo).")
      process.exit(1)
    }

    const env: Record<string, string> = {
      // Enable sync gating inside remote sandboxes by default.
      OPENCODE_SYNC_GATING: "true",
      ...(process.env.OPENCODE_SERVER_PASSWORD ? { OPENCODE_SERVER_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD } : {}),
    }
    if (args.url) env.OPENCODE_SANDBOX_URL = String(args.url)
    for (const item of args.env ?? []) {
      const raw = String(item)
      const idx = raw.indexOf("=")
      if (idx <= 0) continue
      env[raw.slice(0, idx)] = raw.slice(idx + 1)
    }

    const input: Sandbox.CreateInput = {
      provider: String(args.provider),
      name: args.name ? String(args.name) : undefined,
      repo: { url: repoUrl, ref },
      ttl: args.ttl || args.idle ? { ttlSeconds: args.ttl ? Number(args.ttl) : undefined, idleSeconds: args.idle ? Number(args.idle) : undefined } : undefined,
      resources:
        args.cpu || args.mem || args.disk
          ? {
              cpu: args.cpu ? Number(args.cpu) : undefined,
              memoryMB: args.mem ? Number(args.mem) : undefined,
              diskGB: args.disk ? Number(args.disk) : undefined,
            }
          : undefined,
      env,
    }

    if (!args.yes) {
      prompts.intro("Sandbox create")
      const ok = await prompts.confirm({
        message: `Create sandbox (${input.provider}) for ${repoUrl} @ ${ref.slice(0, 12)}...?`,
        initialValue: false,
      })
      if (prompts.isCancel(ok) || ok === false) {
        prompts.outro("Cancelled")
        process.exit(1)
      }
      prompts.outro("Proceeding")
    }

    const provider = SandboxProviders.resolve(String(args.provider))
    const handle = await provider.create(input)

    if (args.format === "json") {
      console.log(JSON.stringify(handle, null, 2))
      return
    }

    console.log(`sandbox id: ${handle.id}`)
    console.log(`provider: ${handle.provider}`)
    if (handle.url) {
      console.log(`server url: ${handle.url}`)
      console.log()
      console.log(`Attach with:`)
      console.log(`  opencode run --attach ${handle.url} "your prompt here"`)
    } else {
      console.log("server url: (not provided by provider)")
      console.log("Hint: set OPENCODE_SANDBOX_URL (or implement provider URL exposure).")
      const bootstrap = (handle.metadata as any)?.bootstrap
      if (bootstrap) {
        console.log()
        console.log("Provider bootstrap script (best-effort):")
        console.log(bootstrap)
      }
    }
  },
})

export const SandboxStopCommand = cmd({
  command: "stop <id>",
  describe: "stop a sandbox",
  builder: (yargs: Argv) =>
    yargs
      .positional("id", { describe: "sandbox id", type: "string", demandOption: true })
      .option("provider", {
        describe: "sandbox provider (e.g., modal, fake)",
        type: "string",
        default: process.env.OPENCODE_SANDBOX_PROVIDER ?? "modal",
      }),
  handler: async (args) => {
    const provider = SandboxProviders.resolve(String(args.provider))
    await provider.stop(String(args.id))
    console.log("ok")
  },
})

export const SandboxSnapshotCommand = cmd({
  command: "snapshot <id>",
  describe: "create a sandbox snapshot (provider-dependent)",
  builder: (yargs: Argv) =>
    yargs
      .positional("id", { describe: "sandbox id", type: "string", demandOption: true })
      .option("provider", {
        describe: "sandbox provider (e.g., modal, fake)",
        type: "string",
        default: process.env.OPENCODE_SANDBOX_PROVIDER ?? "modal",
      }),
  handler: async (args) => {
    const provider = SandboxProviders.resolve(String(args.provider))
    const snap = await provider.snapshot(String(args.id))
    console.log(JSON.stringify(snap, null, 2))
  },
})

export const SandboxRestoreCommand = cmd({
  command: "restore",
  describe: "restore a sandbox from a snapshot ref (provider-dependent)",
  builder: (yargs: Argv) =>
    yargs
      .option("provider", {
        describe: "sandbox provider (e.g., modal, fake)",
        type: "string",
        default: process.env.OPENCODE_SANDBOX_PROVIDER ?? "modal",
      })
      .option("ref", {
        describe: "snapshot ref string",
        type: "string",
        demandOption: true,
      }),
  handler: async (args) => {
    const provider = SandboxProviders.resolve(String(args.provider))
    const snap = Sandbox.SnapshotRef.parse({ provider: String(args.provider), ref: String(args.ref), time: { created: Date.now() } })
    const handle = await provider.restore(snap)
    console.log(JSON.stringify(handle, null, 2))
  },
})

