import { domain } from "./stage"
import { ADMIN_SECRET } from "./secrets"

const disableCustomDomain = process.env.OPENCODE_DISABLE_CUSTOM_DOMAIN === "1"
const disableZen = process.env.OPENCODE_DISABLE_ZEN === "1"

////////////////
// DATABASE
////////////////

export const database = new sst.cloudflare.D1("Database")

new sst.x.DevCommand("Studio", {
  link: [database],
  dev: {
    command: "bun db studio",
    directory: "packages/console/core",
    autostart: true,
  },
})

////////////////
// AUTH
////////////////

const GITHUB_CLIENT_ID_CONSOLE = new sst.Secret("GITHUB_CLIENT_ID_CONSOLE")
const GITHUB_CLIENT_SECRET_CONSOLE = new sst.Secret("GITHUB_CLIENT_SECRET_CONSOLE")
const GOOGLE_CLIENT_ID = new sst.Secret("GOOGLE_CLIENT_ID")
const authStorage = new sst.cloudflare.Kv("AuthStorage")
export const auth = new sst.cloudflare.Worker("AuthApi", {
  domain: disableCustomDomain ? undefined : `auth.${domain}`,
  handler: "packages/console/function/src/auth.ts",
  url: true,
  link: [database, authStorage, GITHUB_CLIENT_ID_CONSOLE, GITHUB_CLIENT_SECRET_CONSOLE, GOOGLE_CLIENT_ID],
})

////////////////
// GATEWAY
////////////////

const stripeEnabled = process.env.OPENCODE_DISABLE_STRIPE !== "1" && Boolean(process.env.STRIPE_SECRET_KEY)
let STRIPE_SECRET_KEY: sst.Secret | undefined
let STRIPE_WEBHOOK_SECRET: sst.Linkable | undefined

if (stripeEnabled) {
  STRIPE_SECRET_KEY = new sst.Secret("STRIPE_SECRET_KEY")
  const stripeWebhook = new stripe.WebhookEndpoint("StripeWebhookEndpoint", {
    url: $interpolate`https://${domain}/stripe/webhook`,
    enabledEvents: [
      "checkout.session.async_payment_failed",
      "checkout.session.async_payment_succeeded",
      "checkout.session.completed",
      "checkout.session.expired",
      "charge.refunded",
      "invoice.payment_succeeded",
      "customer.created",
      "customer.deleted",
      "customer.updated",
      "customer.discount.created",
      "customer.discount.deleted",
      "customer.discount.updated",
      "customer.source.created",
      "customer.source.deleted",
      "customer.source.expiring",
      "customer.source.updated",
      "customer.subscription.created",
      "customer.subscription.deleted",
      "customer.subscription.paused",
      "customer.subscription.pending_update_applied",
      "customer.subscription.pending_update_expired",
      "customer.subscription.resumed",
      "customer.subscription.trial_will_end",
      "customer.subscription.updated",
    ],
  })

  const zenProduct = new stripe.Product("ZenBlack", {
    name: "OpenCode Black",
  })
  new stripe.Price("ZenBlackPrice", {
    product: zenProduct.id,
    unitAmount: 20000,
    currency: "usd",
    recurring: {
      interval: "month",
      intervalCount: 1,
    },
  })

  STRIPE_WEBHOOK_SECRET = new sst.Linkable("STRIPE_WEBHOOK_SECRET", {
    properties: { value: stripeWebhook.secret },
  })
}

const ZEN_MODELS = disableZen
  ? []
  : [
      new sst.Secret("ZEN_MODELS1"),
      new sst.Secret("ZEN_MODELS2"),
      new sst.Secret("ZEN_MODELS3"),
      new sst.Secret("ZEN_MODELS4"),
      new sst.Secret("ZEN_MODELS5"),
      new sst.Secret("ZEN_MODELS6"),
      new sst.Secret("ZEN_MODELS7"),
    ]
const ZEN_BLACK = disableZen ? undefined : new sst.Secret("ZEN_BLACK")
const AUTH_API_URL = new sst.Linkable("AUTH_API_URL", {
  properties: { value: auth.url.apply((url) => url!) },
})
const gatewayKv = new sst.cloudflare.Kv("GatewayKv")

////////////////
// CONSOLE
////////////////

const bucket = new sst.cloudflare.Bucket("ZenData")
const bucketNew = new sst.cloudflare.Bucket("ZenDataNew")

let logProcessor
if ($app.stage === "production" || $app.stage === "frank") {
  const HONEYCOMB_API_KEY = new sst.Secret("HONEYCOMB_API_KEY")
  logProcessor = new sst.cloudflare.Worker("LogProcessor", {
    handler: "packages/console/function/src/log-processor.ts",
    link: [HONEYCOMB_API_KEY],
  })
}

new sst.cloudflare.x.SolidStart("Console", {
  domain: disableCustomDomain ? undefined : domain,
  path: "packages/console/app",
  link: [
    bucket,
    bucketNew,
    database,
    auth,
    AUTH_API_URL,
    ...(STRIPE_WEBHOOK_SECRET && STRIPE_SECRET_KEY ? [STRIPE_WEBHOOK_SECRET, STRIPE_SECRET_KEY] : []),
    ADMIN_SECRET,
    ...(ZEN_BLACK ? [ZEN_BLACK] : []),
    ...ZEN_MODELS,
    ...($dev
      ? [
          new sst.Secret("CLOUDFLARE_DEFAULT_ACCOUNT_ID", process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID!),
          new sst.Secret("CLOUDFLARE_API_TOKEN", process.env.CLOUDFLARE_API_TOKEN!),
        ]
      : []),
    gatewayKv,
  ],
  environment: {
    //VITE_DOCS_URL: web.url.apply((url) => url!),
    //VITE_API_URL: gateway.url.apply((url) => url!),
    VITE_AUTH_URL: auth.url.apply((url) => url!),
  },
  transform: {
    server: {
      transform: {
        worker: {
          placement: { mode: "smart" },
          tailConsumers: logProcessor ? [{ service: logProcessor.nodes.worker.scriptName }] : [],
        },
      },
    },
  },
})
