import { Sandbox } from "./types"
import { SandboxFake } from "./fake"
import { SandboxModal } from "./modal"

export namespace SandboxProviders {
  export type ProviderName = "modal" | "fake"

  export function resolve(name?: string): Sandbox.Provider {
    const provider = (name ?? process.env.OPENCODE_SANDBOX_PROVIDER ?? "fake").toLowerCase()
    if (provider === "modal") return SandboxModal.provider()
    return SandboxFake.provider()
  }
}

