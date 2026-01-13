import { $ } from "bun"
import z from "zod"
import { Snapshot } from "@/snapshot"
import { fn } from "@/util/fn"
import { Instance } from "@/project/instance"

export namespace SessionClosedLoop {
  export const CommandResult = z.object({
    command: z.string(),
    exitCode: z.number(),
    stdout: z.string(),
    stderr: z.string(),
  })
  export type CommandResult = z.infer<typeof CommandResult>

  export const VerifyInput = z.object({
    patch: Snapshot.Patch,
    commands: z.array(z.string()).min(1),
    revertOnFail: z.boolean().optional().default(true),
  })
  export type VerifyInput = z.infer<typeof VerifyInput>

  export const VerifyOutput = z.object({
    ok: z.boolean(),
    reverted: z.boolean(),
    results: z.array(CommandResult),
  })
  export type VerifyOutput = z.infer<typeof VerifyOutput>

  async function runCommand(command: string) {
    const started = Date.now()
    const proc =
      process.platform === "win32"
        ? await $`cmd /c ${command}`.nothrow().cwd(Instance.directory)
        : await $`bash -lc ${command}`.nothrow().cwd(Instance.directory)

    // Bun's `$` returns stdout/stderr as Uint8Array
    const stdout = proc.stdout ? proc.stdout.toString() : ""
    const stderr = proc.stderr ? proc.stderr.toString() : ""
    const exitCode = proc.exitCode ?? 0

    return {
      command,
      exitCode,
      stdout,
      stderr,
      started,
      ended: Date.now(),
    }
  }

  export const verifyAndRevert = fn(VerifyInput, async (input): Promise<VerifyOutput> => {
    const results: CommandResult[] = []
    let ok = true

    for (const cmd of input.commands) {
      const res = await runCommand(cmd)
      results.push({
        command: res.command,
        exitCode: res.exitCode,
        stdout: res.stdout,
        stderr: res.stderr,
      })
      if (res.exitCode !== 0) {
        ok = false
        break
      }
    }

    let reverted = false
    if (!ok && input.revertOnFail) {
      await Snapshot.revert([input.patch])
      reverted = true
    }

    return {
      ok,
      reverted,
      results,
    }
  })
}

