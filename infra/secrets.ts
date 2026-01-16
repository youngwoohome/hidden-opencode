const disableEmail = process.env.OPENCODE_DISABLE_EMAIL === "1"

export const EMAILOCTOPUS_API_KEY = disableEmail ? undefined : new sst.Secret("EMAILOCTOPUS_API_KEY")
export const ADMIN_SECRET = new sst.Secret("ADMIN_SECRET")
