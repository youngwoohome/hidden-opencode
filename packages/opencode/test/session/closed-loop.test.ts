import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Snapshot } from "../../src/snapshot"
import { tmpdir } from "../fixture/fixture"
import { SessionClosedLoop } from "../../src/session/closed-loop"

describe("SessionClosedLoop.verifyAndRevert", () => {
  test("reverts changed files to snapshot when verification fails", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "hello.txt"), "before\n")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const snapshot = await Snapshot.track()
        expect(snapshot).toBeTruthy()

        await Bun.write(path.join(tmp.path, "hello.txt"), "after\n")

        const patch = await Snapshot.patch(snapshot!)
        expect(patch.files.length).toBeGreaterThanOrEqual(1)

        const result = await SessionClosedLoop.verifyAndRevert({
          patch,
          commands: ["exit 1"],
          revertOnFail: true,
        })

        expect(result.ok).toBe(false)
        expect(result.reverted).toBe(true)

        const content = await Bun.file(path.join(tmp.path, "hello.txt")).text()
        expect(content).toBe("before\n")
      },
    })
  })
})

