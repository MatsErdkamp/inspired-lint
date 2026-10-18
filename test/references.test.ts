import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { readRepositories } from "../src/corpus.ts"
import { ConfigSchema } from "../src/model.ts"
import { referenceRepositories, syncReferences } from "../src/references.ts"

const git = (root: string, args: string[]): string => {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf-8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "inspired-reference-"))
  const upstream = path.join(root, "upstream")
  const codebase = path.join(root, "codebase")
  await mkdir(path.join(upstream, "packages", "ref", "src"), { recursive: true })
  await mkdir(path.join(codebase, "packages", "app", "src"), { recursive: true })
  await writeFile(path.join(upstream, "packages", "ref", "src", "index.ts"), "export const value = 1\n")
  git(upstream, ["init", "-q"])
  git(upstream, ["add", "."])
  git(upstream, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "one"])
  const commit = git(upstream, ["rev-parse", "HEAD"])
  const config = ConfigSchema.parse({ version: 3, referenceCacheDirectory: path.join(root, "cache"), repositories: [{ label: "codebase", root: codebase }], references: [{ label: "reference", url: upstream, commit, include: ["packages/ref/src/**/*.ts"] }], lanes: [{ id: "test", angle: "test" }] })
  return { root, upstream, config, commit }
}

test("pinned references clone, stay detached, update idempotently and join measurement repositories", async () => {
  const f = await fixture()
  try {
    const first = await syncReferences(f.config)
    assert.equal(first[0]?.commit, f.commit)
    const checkout = path.join(f.root, "cache", "reference")
    assert.equal(git(checkout, ["rev-parse", "HEAD"]), f.commit)
    assert.equal(spawnSync("git", ["-C", checkout, "symbolic-ref", "-q", "HEAD"]).status, 1)
    assert.deepEqual(await syncReferences(f.config), first)
    assert.deepEqual((await readRepositories(f.config)).map((repo) => [repo.label, repo.files.length]), [["codebase", 0], ["reference", 1]])
    await writeFile(path.join(f.upstream, "packages", "ref", "src", "index.ts"), "export const value = 2\n")
    git(f.upstream, ["add", "."])
    git(f.upstream, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "two"])
    const secondCommit = git(f.upstream, ["rev-parse", "HEAD"])
    const config = { ...f.config, references: [{ label: "reference", url: f.upstream, commit: secondCommit }] }
    await assert.rejects(referenceRepositories(config), /not at its pinned commit/u)
    await syncReferences(config)
    assert.equal(git(checkout, ["rev-parse", "HEAD"]), secondCommit)
    assert.equal(await readFile(path.join(checkout, "packages", "ref", "src", "index.ts"), "utf-8"), "export const value = 2\n")
  } finally {
    await rm(f.root, { force: true, recursive: true })
  }
})

test("reference sync refuses dirty and unmanaged destinations without deleting source", async () => {
  const f = await fixture()
  try {
    await syncReferences(f.config)
    const checkout = path.join(f.root, "cache", "reference")
    const file = path.join(checkout, "packages", "ref", "src", "index.ts")
    await writeFile(file, "local work\n")
    await assert.rejects(syncReferences(f.config), /local changes/u)
    assert.equal(await readFile(file, "utf-8"), "local work\n")
    await assert.rejects(referenceRepositories(f.config), /local changes/u)
    const unmanaged = path.join(f.root, "cache", "unmanaged")
    await mkdir(unmanaged)
    await writeFile(path.join(unmanaged, "keep.txt"), "keep")
    const config = { ...f.config, references: [{ label: "unmanaged", url: f.upstream, commit: f.commit }] }
    await assert.rejects(syncReferences(config))
    assert.equal(await readFile(path.join(unmanaged, "keep.txt"), "utf-8"), "keep")
  } finally {
    await rm(f.root, { force: true, recursive: true })
  }
})

test("config rejects duplicate reference labels and unpinned revisions without supplying a provider default", async () => {
  const f = await fixture()
  try {
    assert.equal(f.config.decision, undefined)
    assert.throws(() => ConfigSchema.parse({ ...f.config, references: [{ label: "codebase", url: f.upstream, commit: f.commit }] }), /duplicate repository labels/u)
    assert.throws(() => ConfigSchema.parse({ ...f.config, references: [{ label: "reference", url: f.upstream, commit: "main" }] }))
  } finally {
    await rm(f.root, { force: true, recursive: true })
  }
})


test("a pinned reference keeps its own include globs when joined to a different codebase layout", async () => {
  const f = await fixture()
  try {
    const config = { ...f.config, include: ["not-present/**/*.ts"], references: [{ label: "reference", url: f.upstream, commit: f.commit, include: ["packages/ref/src/**/*.ts"] }] }
    await syncReferences(config)
    assert.deepEqual((await readRepositories(config)).map((repo) => [repo.label, repo.files.length]), [["codebase", 0], ["reference", 1]])
  } finally {
    await rm(f.root, { force: true, recursive: true })
  }
})
