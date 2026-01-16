import { z } from "zod"
import { fn } from "./util/fn"
import { Resource } from "@opencode-ai/console-resource"

export namespace BlackData {
  const Schema = z.object({
    fixedLimit: z.number().int(),
    rollingLimit: z.number().int(),
    rollingWindow: z.number().int(),
  })

  export const validate = fn(Schema, (input) => {
    return input
  })

  export const get = fn(z.void(), () => {
    try {
      const json = JSON.parse(Resource.ZEN_BLACK.value)
      return Schema.parse(json)
    } catch (err) {
      if (err instanceof Error && err.message.includes("ZEN_BLACK")) {
        return Schema.parse({ fixedLimit: 0, rollingLimit: 0, rollingWindow: 0 })
      }
      throw err
    }
  })
}
