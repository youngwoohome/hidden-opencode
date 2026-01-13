import z from "zod"

export namespace Sandbox {
  export const ProviderID = z.string().min(1).meta({ ref: "SandboxProviderID" })
  export type ProviderID = z.infer<typeof ProviderID>

  export const Resources = z
    .object({
      cpu: z.number().positive().optional().describe("vCPU units (provider-specific)"),
      memoryMB: z.number().int().positive().optional(),
      diskGB: z.number().positive().optional(),
    })
    .strict()
    .meta({ ref: "SandboxResources" })
  export type Resources = z.infer<typeof Resources>

  export const TTL = z
    .object({
      // Hard wall-clock lifetime
      ttlSeconds: z.number().int().positive().optional(),
      // Idle timeout (provider must track liveness)
      idleSeconds: z.number().int().positive().optional(),
    })
    .strict()
    .meta({ ref: "SandboxTTL" })
  export type TTL = z.infer<typeof TTL>

  export const RepoSpec = z
    .object({
      url: z.string().min(1).describe("Git remote URL (https/ssh)"),
      ref: z.string().min(1).describe("branch/tag/sha to checkout"),
    })
    .strict()
    .meta({ ref: "SandboxRepoSpec" })
  export type RepoSpec = z.infer<typeof RepoSpec>

  export const CreateInput = z
    .object({
      provider: ProviderID.optional(),
      repo: RepoSpec,
      resources: Resources.optional(),
      ttl: TTL.optional(),
      env: z.record(z.string(), z.string()).optional(),
      // Optional hint used by providers for naming
      name: z.string().optional(),
    })
    .strict()
    .meta({ ref: "SandboxCreateInput" })
  export type CreateInput = z.infer<typeof CreateInput>

  export const Handle = z
    .object({
      id: z.string().min(1),
      provider: ProviderID,
      url: z.string().url().optional(),
      repo: RepoSpec.optional(),
      resources: Resources.optional(),
      ttl: TTL.optional(),
      time: z.object({
        created: z.number(),
        expires: z.number().optional(),
      }),
      metadata: z.record(z.string(), z.any()).optional(),
    })
    .strict()
    .meta({ ref: "SandboxHandle" })
  export type Handle = z.infer<typeof Handle>

  export const SnapshotRef = z
    .object({
      provider: ProviderID,
      ref: z.string().min(1),
      time: z.object({
        created: z.number(),
      }),
      metadata: z.record(z.string(), z.any()).optional(),
    })
    .strict()
    .meta({ ref: "SandboxSnapshotRef" })
  export type SnapshotRef = z.infer<typeof SnapshotRef>

  export interface Provider {
    readonly id: ProviderID
    create(input: CreateInput): Promise<Handle>
    get(id: string): Promise<Handle | undefined>
    stop(id: string): Promise<void>
    snapshot(id: string): Promise<SnapshotRef>
    restore(ref: SnapshotRef): Promise<Handle>
  }
}

