import { $ } from "bun"
import path from "path"
import fs from "fs/promises"
import os from "os"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod"
import { Sandbox } from "./types"

export namespace SandboxModal {
  export const ModalError = NamedError.create(
    "SandboxModalError",
    z.object({
      message: z.string(),
      stderr: z.string().optional(),
    }),
  )

  export const NotImplemented = NamedError.create(
    "SandboxNotImplemented",
    z.object({
      message: z.string(),
    }),
  )

  function pythonBin(): string {
    return process.env.OPENCODE_MODAL_PYTHON ?? "python3"
  }

  function helperPath(): string {
    // Keep helper inside the package so it ships with opencode.
    return path.join(import.meta.dir, "modal-helper", "opencode_modal_sandbox.py")
  }

  export function provider(): Sandbox.Provider {
    return {
      id: "modal",
      async create(input) {
        // Only required when using a custom registry image strategy.
        // Default path builds a Modal-native image and installs required tools there.
        const useRegistry = (process.env.OPENCODE_MODAL_USE_REGISTRY_IMAGE ?? "").trim().toLowerCase()
        if (["1", "true", "yes"].includes(useRegistry) && !process.env.OPENCODE_MODAL_IMAGE) {
          throw new ModalError({
            message: "OPENCODE_MODAL_IMAGE is required when OPENCODE_MODAL_USE_REGISTRY_IMAGE=1",
          })
        }
        const py = pythonBin()
        const helper = helperPath()

        const payload = JSON.stringify({
          repo: input.repo,
          resources: input.resources,
          ttl: input.ttl,
          env: input.env,
          name: input.name,
          // Provider-specific knobs (image/app/etc)
          modal: {
            image: process.env.OPENCODE_MODAL_IMAGE,
            app: process.env.OPENCODE_MODAL_APP,
          },
        })

        const outputFile = path.join(
          os.tmpdir(),
          `opencode-modal-sandbox-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
        )
        const res = await $`${py} ${helper} create ${payload}`
          .env({ ...process.env, OPENCODE_MODAL_OUTPUT_FILE: outputFile })
          .quiet()
          .nothrow()
        const out = res.stdout.toString().trim()
        const err = res.stderr.toString().trim()
        try {
          if (res.exitCode !== 0) {
            throw new ModalError({
              message: "Modal sandbox create failed",
              stderr: err || out,
            })
          }

          // Robust: read the JSON handle from an out-of-band file to avoid stdout/stderr mixing and TTY wrapping.
          const fileJson = await fs.readFile(outputFile, "utf8").then((s) => s.trim())
          const handle = Sandbox.Handle.parse(JSON.parse(fileJson))
          handle.metadata = {
            ...(handle.metadata ?? {}),
            syncGatingExpected: true,
          }
          return handle
        } catch (e) {
          const fileBody = await fs.readFile(outputFile, "utf8").catch(() => "")
          if (e instanceof ModalError) throw e
          throw new ModalError({
            message: "Modal helper returned invalid JSON",
            stderr: [
              `outputFile: ${outputFile}`,
              out ? `stdout:\n${out}` : "",
              err ? `stderr:\n${err}` : "",
              fileBody ? `file:\n${fileBody}` : "",
            ]
              .filter(Boolean)
              .join("\n\n"),
          })
        } finally {
          await fs.rm(outputFile, { force: true }).catch(() => undefined)
        }
      },

      async get() {
        // Optional; depending on helper capabilities.
        return undefined
      },

      async stop(id) {
        const py = pythonBin()
        const helper = helperPath()
        const payload = JSON.stringify({ id })
        const res = await $`${py} ${helper} stop ${payload}`.nothrow()
        if (res.exitCode !== 0) {
          throw new ModalError({
            message: "Modal sandbox stop failed",
            stderr: res.stderr.toString().trim() || res.stdout.toString().trim(),
          })
        }
      },

      async snapshot() {
        throw new NotImplemented({ message: "Modal snapshot is not implemented yet (interface is reserved)" })
      },

      async restore() {
        throw new NotImplemented({ message: "Modal restore is not implemented yet (interface is reserved)" })
      },
    }
  }
}

