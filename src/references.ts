import { spawnSync } from "node:child_process"
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

import { z } from "zod"

import type { Config } from "./model.ts"

const markerSchema = z.strictObject({ label: z.string(), url: z.string() })

type Reference = NonNullable<Config["references"]>[number]

const git = (root: string, args: string[]): string => {
  const result = spawnSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "init.templateDir=",
      "-C",
      root,
      ...args,
    ],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
      maxBuffer: 8 * 1024 * 1024,
      timeout: 120_000,
    }
  )

  if (result.status !== 0) {
    throw new Error(`Git reference operation failed: ${result.stderr.trim()}`)
  }

  return result.stdout.trim()
}

const cacheRoot = (config: Config): string =>
  config.referenceCacheDirectory ??
  path.join(homedir(), ".cache", "inspired-lint", "references")

const checkManaged = async (
  root: string,
  reference: Reference
): Promise<void> => {
  const entry = await lstat(root)

  if (entry.isSymbolicLink()) {
    throw new Error("Reference cache entries cannot be symlinks")
  }

  const marker = markerSchema.parse(
    JSON.parse(
      await readFile(path.join(root, ".git", "inspired-lint.json"), "utf-8")
    )
  )

  if (
    marker.url !== reference.url ||
    marker.label !== reference.label ||
    git(root, ["remote", "get-url", "origin"]) !== reference.url
  ) {
    throw new Error(`Reference cache does not belong to ${reference.label}`)
  }

  if (git(root, ["status", "--porcelain"]) !== "") {
    throw new Error(
      `Reference ${reference.label} has local changes; refusing to replace them`
    )
  }
}

/** Resolve pinned, clean, managed reference checkouts without fetching or running reference code. */
export const referenceRepositories = async (
  config: Config
): Promise<Config["repositories"]> =>
  await Promise.all(
    (config.references ?? []).map(async (reference) => {
      const root = path.join(cacheRoot(config), reference.label)
      await checkManaged(root, reference)

      if (git(root, ["rev-parse", "HEAD"]) !== reference.commit) {
        throw new Error(
          `Reference ${reference.label} is not at its pinned commit; run inspired-lint references`
        )
      }

      return {
        exclude: reference.exclude,
        include: reference.include,
        label: reference.label,
        root: await realpath(root),
      }
    })
  )

const syncReference = async (
  cache: string,
  reference: Reference
): Promise<void> => {
  const destination = path.join(cache, reference.label)

  const existing = await lstat(destination).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null
    }

    throw error
  })

  if (existing !== null) {
    await checkManaged(destination, reference)

    if (git(destination, ["rev-parse", "HEAD"]) !== reference.commit) {
      git(destination, [
        "fetch",
        "--depth=1",
        "--no-tags",
        "origin",
        reference.commit,
      ])
      git(destination, [
        "-c",
        "advice.detachedHead=false",
        "checkout",
        "--detach",
        reference.commit,
      ])
    }

    return
  }

  const temporary = await mkdtemp(path.join(cache, ".clone-"))

  try {
    const checkout = path.join(temporary, "checkout")
    git(cache, [
      "clone",
      "--depth=1",
      "--no-checkout",
      "--",
      reference.url,
      checkout,
    ])
    git(checkout, [
      "fetch",
      "--depth=1",
      "--no-tags",
      "origin",
      reference.commit,
    ])
    git(checkout, [
      "-c",
      "advice.detachedHead=false",
      "checkout",
      "--detach",
      reference.commit,
    ])
    await writeFile(
      path.join(checkout, ".git", "inspired-lint.json"),
      JSON.stringify({ label: reference.label, url: reference.url }),
      { mode: 0o600 }
    )
    await rename(checkout, destination)
  } finally {
    await rm(temporary, { force: true, recursive: true })
  }
}

/** Clone or update each pinned reference; refuse dirty or unmanaged cache entries. */
export const syncReferences = async (
  config: Config
): Promise<{ label: string; root: string; commit: string }[]> => {
  const cache = cacheRoot(config)
  await mkdir(cache, { recursive: true })
  await Promise.all(
    (config.references ?? []).map((reference) =>
      syncReference(cache, reference)
    )
  )
  const repositories = await referenceRepositories(config)

  return repositories.map((repository, index) => ({
    ...repository,
    commit: config.references?.[index]?.commit ?? "",
  }))
}
