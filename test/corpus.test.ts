import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { readRepositories } from "../src/corpus.ts"
import { ConfigSchema } from "../src/model.ts"

test("default selection preserves production TypeScript layout and safety exclusions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "inspired-corpus-"))
  try {
    for (const file of ["packages/a/src/one.ts", "packages/a/src/deep/two.tsx", "packages/a/src/one.test.ts", "packages/a/src/types.d.ts", "packages/a/src/fixtures/f.ts", "packages/a/src/vendor/v.ts", "src/elsewhere.ts"]) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true })
      await writeFile(path.join(root, file), "const x = 1")
    }
    const config = ConfigSchema.parse({ version: 3, repositories: [{ label: "codebase", root }], lanes: [{ id: "test", angle: "test" }] })
    const [original] = await readRepositories(config)
    assert.deepEqual(original?.files.map((file) => file.path), ["packages/a/src/deep/two.tsx", "packages/a/src/one.ts"])
    const [excluded] = await readRepositories({ ...config, exclude: ["packages/a/src/deep/**"] })
    assert.deepEqual(excluded?.files.map((file) => file.path), ["packages/a/src/one.ts"])
    const [custom] = await readRepositories({ ...config, include: ["src/**/*.ts", "packages/**/*.ts"], exclude: ["packages/**"] })
    assert.deepEqual(custom?.files.map((file) => file.path), ["src/elsewhere.ts"])
    const [perRepository] = await readRepositories({ ...config, repositories: [{ label: "codebase", root, include: ["src/**/*.ts"] }] })
    assert.deepEqual(perRepository?.files.map((file) => file.path), ["src/elsewhere.ts"])
    const [empty] = await readRepositories({ ...config, include: [] })
    assert.equal(empty?.eligible, 0)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test("custom globs retain test/declaration exclusions and reject escaping symlinks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "inspired-corpus-link-"))
  const outside = await mkdtemp(path.join(tmpdir(), "inspired-outside-"))
  try {
    await mkdir(path.join(root, "src"))
    await writeFile(path.join(root, "src", "one.ts"), "const x = 1")
    await writeFile(path.join(root, "src", "one.spec.ts"), "const x = 1")
    await writeFile(path.join(root, "src", "one.d.ts"), "declare const x: number")
    const config = ConfigSchema.parse({ version: 3, include: ["**/*.ts"], repositories: [{ label: "codebase", root }], lanes: [{ id: "test", angle: "test" }] })
    assert.deepEqual((await readRepositories(config))[0]?.files.map((file) => file.path), ["src/one.ts"])
    await symlink(outside, path.join(root, "src", "outside"))
    await assert.rejects(readRepositories(config), /escaping corpus symlink/u)
  } finally {
    await rm(root, { force: true, recursive: true })
    await rm(outside, { force: true, recursive: true })
  }
})
