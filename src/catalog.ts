import { spawnSync } from "node:child_process"
import { readFile, realpath } from "node:fs/promises"
import path from "node:path"

import { z } from "zod"

import { hash, RuleCatalogSchema, writeJson } from "./model.ts"
import type { RuleCatalog } from "./model.ts"

type Json = z.infer<ReturnType<typeof z.json>>

const objectSchema = z.record(z.string(), z.json())

const outputSchema = z.object({
  overrides: z
    .array(
      z.object({
        files: z.array(z.string()).default([]),
        rules: z.record(z.string(), z.json()).default({}),
      })
    )
    .default([]),
  rules: z.record(z.string(), z.json()).default({}),
})

const registrySchema = z.array(
  z.object({
    category: z.string(),
    docs_url: z.string(),
    fix: z.string(),
    scope: z.string(),
    type_aware: z.boolean(),
    value: z.string(),
  })
)

const canonicalName = (name: string): string => name.replace(/^eslint\//u, "")

const expand = (
  input: Json,
  definitions: Record<string, Json>,
  seen = new Set<string>()
): Json => {
  if (Array.isArray(input)) {
    return input.map((value) => expand(value, definitions, seen))
  }

  const node = objectSchema.safeParse(input)

  if (!node.success) {
    return input
  }

  const ref = node.data.$ref

  if (typeof ref === "string" && ref.startsWith("#/definitions/")) {
    const definition = definitions[ref.slice(14)]

    if (seen.has(ref) || seen.size >= 32 || definition === undefined) {
      return { description: "Recursive or unavailable option schema omitted" }
    }

    return expand(definition, definitions, new Set([...seen, ref]))
  }

  return Object.fromEntries(
    Object.entries(node.data)
      .filter(([key]) => key !== "markdownDescription")
      .map(([key, value]) => [
        key,
        key === "description" && typeof value === "string"
          ? (value.split("\n\n")[0]?.replaceAll(/\s+/gu, " ").slice(0, 200) ??
            "")
          : expand(value, definitions, seen),
      ])
  )
}

const optionNames = (input: Json): string[] => {
  if (Array.isArray(input)) {
    return input.flatMap(optionNames)
  }

  const node = objectSchema.safeParse(input)

  if (!node.success) {
    return []
  }

  const properties = objectSchema.safeParse(node.data.properties)

  return [
    ...(properties.success ? Object.keys(properties.data) : []),
    ...Object.values(node.data).flatMap(optionNames),
  ]
}

/** Build discovery metadata from trusted engine outputs and configured JS-plugin rule names. */
export const catalogFromOutputs = ({
  version,
  configuration,
  registry,
  schema,
  sources,
}: {
  version: string
  configuration: unknown
  registry: unknown
  schema: unknown
  sources: RuleCatalog["sources"]
}): RuleCatalog => {
  const config = outputSchema.parse(configuration)
  const registered = registrySchema.parse(registry)
  const definitions = objectSchema.parse(objectSchema.parse(schema).definitions)

  const map = objectSchema.parse(
    objectSchema.parse(definitions.DummyRuleMap).properties
  )

  const configured = new Map(
    Object.entries(config.rules).map(([name, value]) => [
      canonicalName(name),
      value,
    ])
  )

  const overrides = new Map<string, { files: string[]; value: Json }[]>()

  for (const override of config.overrides) {
    for (const [name, value] of Object.entries(override.rules)) {
      const key = canonicalName(name)
      const entries = overrides.get(key) ?? []
      entries.push({ files: override.files, value })
      overrides.set(key, entries)
    }
  }

  const available = new Map(
    registered.map((rule) => [
      canonicalName(`${rule.scope}/${rule.value}`),
      rule,
    ])
  )

  const names = [
    ...new Set([
      ...available.keys(),
      ...configured.keys(),
      ...overrides.keys(),
    ]),
  ].toSorted()

  return RuleCatalogSchema.parse({
    engine: "oxlint",
    rules: names.map((name) => {
      const rule = available.get(name)
      const options = expand(map[name] ?? null, definitions)
      const keys = [...new Set(optionNames(options))].slice(0, 8)

      return {
        configuration: {
          base: configured.get(name) ?? null,
          overrides: overrides.get(name) ?? [],
        },
        configured: configured.has(name) || overrides.has(name),
        name,
        optionsSchema:
          JSON.stringify(options).length <= 16_000
            ? options
            : {
                description: "Option schema omitted: exceeds 16,000 characters",
              },
        summary:
          rule === undefined
            ? "Configured project/plugin rule; not present in the engine's built-in registry."
            : `${rule.category}; ${rule.type_aware ? "requires type information" : "syntax analysis"}; fix: ${rule.fix}. ${rule.docs_url}${keys.length > 0 ? ` Options: ${keys.join(", ")}.` : ""}`,
      }
    }),
    sources,
    version,
  })
}

// Oxlint print-config omits top-level JS-plugin rules. A fresh process also observes imported preset changes.
const trustedConfigurationScript = `import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"

const configPath = process.argv[1]
const require = createRequire(configPath)
const seen = new Set()
const result = { overrides: [], rules: {} }

const visit = async (value, base = configPath) => {
  if (typeof value === "string") {
    const file = require.resolve(value.startsWith(".") ? path.resolve(path.dirname(base), value) : value)
    const loaded = file.endsWith(".json")
      ? JSON.parse(await readFile(file, "utf-8"))
      : (await import(pathToFileURL(file).href)).default
    return visit(loaded, file)
  }
  if (seen.has(value)) return
  seen.add(value)
  for (const extension of value.extends ?? []) await visit(extension, base)
  Object.assign(result.rules, value.rules)
  result.overrides.push(...(value.overrides ?? []))
  seen.delete(value)
}

const configuration = configPath.endsWith(".json")
  ? JSON.parse(await readFile(configPath, "utf-8"))
  : (await import(pathToFileURL(configPath).href)).default
await visit(configuration)
process.stdout.write(JSON.stringify(result))
`

type Provenance = NonNullable<RuleCatalog["provenance"]>

const execute = (args: string[], cwd: string): string => {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 20_000,
  })

  if (result.status !== 0 || result.stderr.trim() !== "") {
    throw new Error("Installed lint engine metadata command failed")
  }

  return result.stdout
}

const inputFiles = [
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]

const hashFile = async (
  file: string
): Promise<{ path: string; sha256: string }> => ({
  path: file,
  sha256: hash(await readFile(file)),
})

const optionalHash = async (
  file: string
): Promise<{ path: string; sha256: string }[]> => {
  try {
    return [await hashFile(file)]
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      throw error
    }

    return []
  }
}

const readTrustedCatalog = async (
  provenance: Provenance
): Promise<RuleCatalog> => {
  const { engine, config, schema, cwd } = provenance
  const printed = execute([engine, "--print-config", "--config", config], cwd)
  const registry = execute([engine, "--rules", "--format", "json"], cwd)
  const versionOutput = execute([engine, "--version"], cwd)

  const trusted = execute(
    ["--input-type=module", "-e", trustedConfigurationScript, config],
    cwd
  )

  const native = outputSchema.parse(JSON.parse(printed))
  const plugins = outputSchema.parse(JSON.parse(trusted))
  const sources = await Promise.all([engine, config, schema].map(hashFile))

  const additional = await Promise.all(
    [...new Set([cwd, path.dirname(config)])].flatMap((directory) =>
      inputFiles.map((name) => optionalHash(path.join(directory, name)))
    )
  )

  sources.push(
    ...additional.flat(),
    { path: "effective configuration output", sha256: hash(printed) },
    { path: "trusted plugin configuration output", sha256: hash(trusted) },
    { path: "installed rule registry output", sha256: hash(registry) },
    { path: "installed engine version output", sha256: hash(versionOutput) }
  )

  const catalog = catalogFromOutputs({
    configuration: {
      overrides: plugins.overrides,
      rules: { ...native.rules, ...plugins.rules },
    },
    registry: JSON.parse(registry),
    schema: JSON.parse(await readFile(schema, "utf-8")),
    sources,
    version: versionOutput.trim().replace(/^Version:\s*/u, ""),
  })

  return RuleCatalogSchema.parse({ ...catalog, provenance })
}

/** Execute only the explicitly trusted primary configuration and save its installed-rule catalog. */
export const buildCatalog = async ({
  engine,
  config,
  schema,
  output,
  cwd = process.cwd(),
}: {
  engine: string
  config: string
  schema: string
  output: string
  cwd?: string
}): Promise<RuleCatalog> => {
  const configPath = await realpath(config)
  const workingDirectory = await realpath(cwd)
  const enginePath = await realpath(engine)
  const schemaPath = await realpath(schema)

  const provenance = {
    config: configPath,
    cwd: workingDirectory,
    engine: enginePath,
    schema: schemaPath,
  }

  const catalog = await readTrustedCatalog(provenance)
  await writeJson(output, catalog)

  return catalog
}

const stale = (): Error =>
  new Error(
    "Installed-rule catalog is stale or unverifiable; rebuild it from the explicitly trusted primary configuration before preparing an experiment."
  )

/** Refuse stale catalogs before executing changed trusted sources. Imported presets are re-read in a fresh process. */
export const verifyCatalog = async (
  catalog: RuleCatalog
): Promise<{ verified: boolean; reason?: string }> => {
  const { provenance } = catalog

  if (provenance === undefined) {
    return {
      reason:
        "Metadata-only catalog has no trusted provenance; freshness is unverified.",
      verified: false,
    }
  }

  const required = [
    provenance.engine,
    provenance.config,
    provenance.schema,
    "effective configuration output",
    "trusted plugin configuration output",
    "installed rule registry output",
    "installed engine version output",
  ]

  if (
    required.some(
      (file) => !catalog.sources.some((source) => source.path === file)
    )
  ) {
    throw stale()
  }

  try {
    const hashes = await Promise.all(
      catalog.sources
        .filter((source) => path.isAbsolute(source.path))
        .map(
          async (source) => hash(await readFile(source.path)) === source.sha256
        )
    )

    if (hashes.includes(false)) {
      throw stale()
    }

    const current = await readTrustedCatalog(provenance)

    if (
      JSON.stringify(current) !==
      JSON.stringify(RuleCatalogSchema.parse(catalog))
    ) {
      throw stale()
    }
  } catch {
    throw stale()
  }

  return { verified: true }
}
