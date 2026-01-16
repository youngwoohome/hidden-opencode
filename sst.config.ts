/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    const stripeKey = process.env.STRIPE_SECRET_KEY
    return {
      name: "opencode",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage),
      home: "cloudflare",
      providers: {
        ...(stripeKey ? { stripe: { apiKey: stripeKey } } : {}),
      },
    }
  },
  async run() {
    const minimal = process.env.OPENCODE_MINIMAL === "1"
    const consoleOnly = process.env.OPENCODE_CONSOLE_ONLY === "1"
    if (!consoleOnly) {
      await import("./infra/app.js")
    }
    if (!minimal || consoleOnly) {
      await import("./infra/console.js")
    }
  },
})
