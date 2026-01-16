import { domain } from "./stage"
import { ADMIN_SECRET, EMAILOCTOPUS_API_KEY } from "./secrets"

const GITHUB_APP_ID = new sst.Secret("GITHUB_APP_ID")
const GITHUB_APP_PRIVATE_KEY = new sst.Secret("GITHUB_APP_PRIVATE_KEY")
const SANDBOX_CONTROLLER_URL = new sst.Secret("SANDBOX_CONTROLLER_URL")
const bucket = new sst.cloudflare.Bucket("Bucket")
const minimal = process.env.OPENCODE_MINIMAL === "1"
const disableCustomDomain = process.env.OPENCODE_DISABLE_CUSTOM_DOMAIN === "1"
const disableLogpush = process.env.OPENCODE_DISABLE_LOGPUSH === "1" || minimal
const disableSyncServer =
  process.env.OPENCODE_DISABLE_SYNC_SERVER === "1" || minimal
const consoleUrlOverride = process.env.OPENCODE_CONSOLE_URL ?? process.env.CONSOLE_URL

export const api = new sst.cloudflare.Worker("Api", {
  domain: disableCustomDomain ? undefined : `api.${domain}`,
  handler: "packages/function/src/api.ts",
  environment: {
    WEB_DOMAIN: disableCustomDomain ? "localhost" : domain,
    SANDBOX_CONTROLLER_URL: SANDBOX_CONTROLLER_URL.value,
    CONSOLE_URL: consoleUrlOverride ?? `https://${domain}`,
  },
  url: true,
  link: [bucket, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, ADMIN_SECRET],
  transform: {
    worker: (args) => {
      args.logpush = !disableLogpush
      if (!disableSyncServer) {
        args.bindings = $resolve(args.bindings).apply((bindings) => [
          ...bindings,
          {
            name: "SYNC_SERVER",
            type: "durable_object_namespace",
            className: "SyncServer",
          },
          {
            name: "SESSION_REGISTRY",
            type: "durable_object_namespace",
            className: "SessionRegistry",
          },
        ])
        args.migrations = [
          {
            tag: "v1",
            newClasses: ["SyncServer", "SessionRegistry"],
          },
        ]
      }
    },
  },
})

if (!minimal) {
  new sst.cloudflare.x.Astro("Web", {
    domain: disableCustomDomain ? undefined : "docs." + domain,
    path: "packages/web",
    environment: {
      // For astro config
      SST_STAGE: $app.stage,
      VITE_API_URL: api.url.apply((url) => url!),
    },
  })

  new sst.cloudflare.StaticSite("WebApp", {
    domain: disableCustomDomain ? undefined : "app." + domain,
    path: "packages/app",
    build: {
      command: "bun turbo build",
      output: "./dist",
    },
  })
}
