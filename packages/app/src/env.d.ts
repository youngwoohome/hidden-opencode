interface ImportMetaEnv {
  readonly VITE_OPENCODE_SERVER_HOST: string
  readonly VITE_OPENCODE_SERVER_PORT: string
  readonly VITE_INSPECT_API_URL?: string
  readonly VITE_INSPECT_REPOS?: string
  readonly VITE_INSPECT_REPO_URL?: string
  readonly VITE_INSPECT_REPO_REF?: string
  readonly VITE_INSPECT_MODEL?: string
  readonly VITE_INSPECT_SANDBOX_PROVIDER?: string
  readonly VITE_INSPECT_AUTH_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
