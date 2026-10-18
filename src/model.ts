import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"

import { z } from "zod"

import { BuiltinRuleSchema, limitsSchema, PluginRuleSchema } from "./oxlint.ts"

const absolute = z.string().refine(path.isAbsolute, "absolute path required")

export const RuleCatalogSchema = z.strictObject({
  engine: z.string().min(1).max(80),
  provenance: z
    .strictObject({
      config: absolute,
      cwd: absolute,
      engine: absolute,
      schema: absolute,
    })
    .optional(),
  rules: z
    .array(
      z.strictObject({
        configuration: z.json(),
        configured: z.boolean(),
        name: z.string().min(1).max(200),
        optionsSchema: z.json(),
        summary: z.string().max(2000),
      })
    )
    .max(5000),
  sources: z
    .array(
      z.strictObject({
        path: z.string(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      })
    )
    .max(20),
  version: z.string().min(1).max(80),
})

export type RuleCatalog = z.infer<typeof RuleCatalogSchema>

/** Which TanStack AI decider answers semantic questions. Keys come from each provider package's environment variables. */
export const DecisionConfigSchema = z.strictObject({
  concurrency: z.number().int().min(1).max(32).default(4),
  inputPricePerMillionTokens: z.number().nonnegative().optional(),
  maxDecisions: z.number().int().positive().default(20_000),
  maxSnippetChars: z.number().int().min(200).max(64_000).default(4000),
  model: z.string().min(1),
  provider: z.enum([
    "cf-cli",
    "cloudflare",
    "typesafe",
    "openai",
    "openrouter",
    "ollaya",
  ]),
  snippetsPerRequest: z.number().int().min(1).max(64).default(16),
  timeoutMs: z.number().int().positive().max(300_000).default(30_000),
})

export type DecisionConfig = z.infer<typeof DecisionConfigSchema>

/** A pinned reference fetched into the reference cache. Existing root repositories need no clone. */
const corpusFields = {
  exclude: z.array(z.string().min(1)).optional(),
  include: z.array(z.string().min(1)).optional(),
}

export const ReferenceSchema = z.strictObject({
  ...corpusFields,
  commit: z.string().regex(/^[a-f0-9]{40}$/u),
  label: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
  url: z
    .string()
    .min(1)
    .refine(
      (value) => !value.startsWith("-"),
      "repository URL cannot be an option"
    ),
})

export const ConfigSchema = z
  .strictObject({
    decision: DecisionConfigSchema.optional(),
    exclude: z.array(z.string().min(1)).optional(),
    include: z.array(z.string().min(1)).optional(),
    lanes: z
      .array(
        z.strictObject({
          angle: z.string().min(1),
          id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
        })
      )
      .min(1),
    limits: limitsSchema.optional(),
    maxFilesPerRepository: z.number().int().positive().optional(),
    referenceCacheDirectory: absolute.optional(),
    references: z.array(ReferenceSchema).optional(),
    repositories: z
      .array(
        z.strictObject({
          ...corpusFields,
          label: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
          root: absolute,
        })
      )
      .min(1),
    ruleCatalogFile: absolute.optional(),
    version: z.literal(3),
  })
  .superRefine((value, context) => {
    for (const [name, values] of [
      [
        "repository labels",
        [...value.repositories, ...(value.references ?? [])].map(
          (item) => item.label
        ),
      ],
      ["lane ids", value.lanes.map((item) => item.id)],
    ] satisfies [string, string[]][]) {
      if (new Set(values).size !== values.length) {
        context.addIssue({ code: "custom", message: `duplicate ${name}` })
      }
    }
  })

const candidateFields = {
  fixtures: z.strictObject({
    fixed: z.string(),
    negative: z.string(),
    positive: z.string(),
  }),
  knownLimitations: z.array(z.string().max(4000)).max(30),
  options: z.array(z.json()).max(20),
  rationale: z.string().min(1).max(20_000),
}

/**
 * A built-in Oxlint rule with options, or a new rule written as an ES module whose default export is
 * `{ meta, create(context) }`, ready to add to a `tools/oxlint` plugin, or a semantic rule built on such a selector.
 * A plugin or semantic rule's `id` is its rule name.
 */
export const CandidateSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...candidateFields,
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/u),
    kind: z.literal("builtin"),
    rule: BuiltinRuleSchema,
  }),
  z.strictObject({
    ...candidateFields,
    code: z.string().min(1).max(200_000),
    id: PluginRuleSchema,
    kind: z.literal("plugin"),
  }),
  // A deterministic selector (a plugin rule whose reports are candidates) plus a yes/no question a decision model answers
  // for each candidate. A candidate is a finding when the probability reaches `cutoff`.
  z.strictObject({
    ...candidateFields,
    context: z
      .strictObject({
        after: z.number().int().min(0).max(200).default(0),
        before: z.number().int().min(0).max(200).default(0),
      })
      .default({ after: 0, before: 0 }),
    cutoff: z.number().gt(0).lt(1),
    id: PluginRuleSchema,
    kind: z.literal("semantic"),
    question: z.string().min(10).max(4000),
    selector: z.string().min(1).max(200_000),
  }),
])

export type Config = z.infer<typeof ConfigSchema>

export type Candidate = z.infer<typeof CandidateSchema>

export type Limits = z.infer<typeof limitsSchema>

export const hash = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex")

export const parseCandidate = (value: unknown): Candidate =>
  CandidateSchema.parse(value)

export const readJson = async (
  file: string
): Promise<z.infer<ReturnType<typeof z.json>>> =>
  z.json().parse(JSON.parse(await readFile(file, "utf-8")))

export const writeJson = async (
  file: string,
  value: unknown
): Promise<void> => {
  await mkdir(path.dirname(file), { mode: 0o700, recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  })
  await rename(temporary, file)
}
