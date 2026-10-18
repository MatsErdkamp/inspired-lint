import { readFile, readdir, realpath } from "node:fs/promises"
import path from "node:path"

import { ConfigSchema, hash, readJson } from "./model.ts"
import type { Config } from "./model.ts"
import { referenceRepositories } from "./references.ts"

const excluded = new Set([
  "test",
  "tests",
  "__tests__",
  "fixtures",
  "__fixtures__",
  "generated",
  "__generated__",
  "vendor",
  "node_modules",
  ".git",
])

/** Whether a resolved path belongs to its repository. */
export const within = (child: string, parent: string): boolean => {
  const relative = path.relative(parent, child)

  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  )
}

const selected = (file: string, config: Config): boolean => {
  const parts = file.split("/")

  const layout =
    config.include === undefined
      ? parts[0] === "packages" &&
        parts.length >= 4 &&
        parts.slice(2).includes("src")
      : config.include.some((pattern) => path.matchesGlob(file, pattern))

  return (
    layout &&
    /\.tsx?$/u.test(file) &&
    !/\.d\.ts$|\.(?:test|spec)\.tsx?$/u.test(file) &&
    !parts.some((part) => excluded.has(part)) &&
    !(config.exclude ?? []).some((pattern) => path.matchesGlob(file, pattern))
  )
}

const sourcePaths = async (root: string, config: Config): Promise<string[]> => {
  const walk = async (directory: string): Promise<string[]> => {
    const entries = await readdir(directory, { withFileTypes: true })

    const groups = await Promise.all(
      entries.map(async (entry) => {
        if (excluded.has(entry.name)) {
          return []
        }

        const file = path.join(directory, entry.name)

        if (entry.isSymbolicLink()) {
          if (!within(await realpath(file), root)) {
            throw new Error("escaping corpus symlink")
          }

          return []
        }

        if (entry.isDirectory()) {
          return await walk(file)
        }

        const relative = path.relative(root, file).split(path.sep).join("/")

        return entry.isFile() && selected(relative, config) ? [file] : []
      })
    )

    return groups.flat().toSorted((a, b) => a.localeCompare(b))
  }

  const start =
    config.include === undefined ? path.join(root, "packages") : root

  if (!within(await realpath(start), root)) {
    throw new Error("escaping corpus symlink")
  }

  return await walk(start)
}

/** Validate a config and resolve local repository roots. Pinned references are synchronized separately. */
export const loadConfig = async (file: string): Promise<Config> => {
  const config = ConfigSchema.parse(await readJson(file))

  const repositories = await Promise.all(
    config.repositories.map(async (repository) => ({
      ...repository,
      root: await realpath(repository.root),
    }))
  )

  return { ...config, repositories }
}

export type SourceFile = {
  id: string
  label: string
  path: string
  source: string
}

/** Read selected source; maxFilesPerRepository keeps the original fixed path-ranked subset. */
export const readRepositories = async (
  config: Config
): Promise<
  { label: string; root: string; eligible: number; files: SourceFile[] }[]
> => {
  const repositories = [
    ...config.repositories,
    ...(await referenceRepositories(config)),
  ]

  return await Promise.all(
    repositories.map(async (repository) => {
      const { label, root: configured } = repository

      const root = await realpath(configured)

      const paths = await sourcePaths(root, {
        ...config,
        exclude: [...(config.exclude ?? []), ...(repository.exclude ?? [])],
        include: repository.include ?? config.include,
      })

      const chosen =
        config.maxFilesPerRepository === undefined
          ? paths
          : paths
              .toSorted((a, b) =>
                hash(path.relative(root, a)).localeCompare(
                  hash(path.relative(root, b))
                )
              )
              .slice(0, config.maxFilesPerRepository)
              .toSorted()

      const files = await Promise.all(
        chosen.map(async (file) => {
          const relative = path.relative(root, file).split(path.sep).join("/")

          return {
            id: `${label}/${relative}`,
            label,
            path: relative,
            source: await readFile(file, "utf-8"),
          }
        })
      )

      return { eligible: paths.length, files, label, root }
    })
  )
}
