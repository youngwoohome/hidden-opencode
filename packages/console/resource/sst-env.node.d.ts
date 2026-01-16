import "sst"

declare module "sst" {
  export interface Resource {
    CLOUDFLARE_API_TOKEN: {
      type: "sst.sst.Secret"
      value: string
    }
    CLOUDFLARE_DEFAULT_ACCOUNT_ID: {
      type: "sst.sst.Secret"
      value: string
    }
  }
}

export {}
