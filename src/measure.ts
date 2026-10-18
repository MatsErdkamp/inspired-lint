import type { AnyEvaluateAdapter } from "@tanstack/ai"
import { z } from "zod"

import { verifyCatalog } from "./catalog.ts"
import { readRepositories } from "./corpus.ts"
import type { SourceFile } from "./corpus.ts"
import { decideAll, estimate, openCache } from "./decide.ts"
import type { DecisionCache, DecisionOutcome } from "./decide.ts"
import { parseCandidate, readJson, RuleCatalogSchema } from "./model.ts"
import type { Candidate, Config, DecisionConfig, Limits } from "./model.ts"
import { evaluateRule } from "./oxlint.ts"
import type { Diagnostic } from "./oxlint.ts"

export type Finding = {
  path: string
  line: number
  column: number
  excerpt: string
  probability?: number
}

export type RepositoryResult = {
  label: string
  eligible: number
  files: number
  affected: number
  rate: number
  findings: number
  durationMs: number
}

/** Codebase rate against each reference: the number the search optimizes. A zero reference rate gives no ratio. */
export type Contrast = {
  codebaseRate: number
  maxReferenceRate: number
  difference: number
  ratios: Record<string, number | null>
}

/** Rates at each cutoff for a semantic rule; cutoff 0 is the selector alone. */
export type CurvePoint = {
  cutoff: number
  rates: Record<string, number>
  difference: number
}

export type Semantic = {
  estimate: ReturnType<typeof estimate>
  decisions: Omit<DecisionOutcome, "probabilities">
  curve: CurvePoint[]
  /** The cutoff with the largest difference while every reference stays at or under 2%; descriptive, not applied. */
  bestCutoff: number | null
  candidates: Record<string, number>
}

export type Measurement = {
  contrast: Contrast | null
  candidate: Candidate
  fixtures: Fixtures
  status: "valid" | "invalid"
  errorCode: string | null
  /** Oxlint's own message when the rule failed to load or threw. */
  detail: string | null
  repositories: RepositoryResult[]
  /** Every finding in the first configured repository, the codebase. */
  codebaseFindings: Finding[]
  /** Up to five findings from distinct files in each reference. */
  referenceExamples: Record<string, Finding[]>
  semantic: Semantic | null
}

/** How a semantic rule reaches its decision model. Tests pass an adapter; the CLI reads config and the cache file. */
export type DecisionContext = {
  config?: DecisionConfig
  cache?: DecisionCache
  mode?: "ask" | "replay"
  adapter?: AnyEvaluateAdapter
}

const evaluate = (
  candidate: Candidate,
  input: readonly { id: string; source: string }[],
  limits?: Limits
) => {
  const files = input.map(({ id, source }) => ({ id, source }))

  if (candidate.kind === "builtin") {
    return evaluateRule({
      files,
      limits,
      options: candidate.options,
      rule: candidate.rule,
    })
  }

  return evaluateRule({
    files,
    limits,
    options: candidate.options,
    plugin: candidate.kind === "plugin" ? candidate.code : candidate.selector,
    rule: candidate.id,
  })
}

/**
 * The source a decision model sees for one candidate: the reported node's lines, widened to `context:A-B` when the
 * selector's message names a line range, plus the candidate's extra lines. The node is wrapped in the two markers.
 */
export const snippetFor = (
  source: string,
  diagnostic: Diagnostic,
  context: { before: number; after: number }
): string => {
  const lines = source.split(/\r\n|\r|\n/u)

  let from = diagnostic.line
  let to = diagnostic.endLine

  const named = /^context:(?<from>\d+)-(?<to>\d+)$/u.exec(diagnostic.message)

  if (named) {
    from = Math.min(from, Number(named.groups?.from))
    to = Math.max(to, Number(named.groups?.to))
  }

  from = Math.max(1, from - context.before)
  to = Math.min(lines.length, to + context.after)
  const out = lines.slice(from - 1, to)

  const mark = (index: number, column: number, marker: string) => {
    const text = out[index]

    if (text !== undefined) {
      out[index] = text.slice(0, column - 1) + marker + text.slice(column - 1)
    }
  }

  mark(diagnostic.endLine - from, diagnostic.endColumn, "/*<<*/")
  mark(diagnostic.line - from, diagnostic.column, "/*>>*/")

  return out.join("\n")
}

const decisionsFor = async (
  candidate: Extract<Candidate, { kind: "semantic" }>,
  items: { key: string; snippet: string }[],
  decisions: DecisionContext
) => {
  if (!decisions.config) {
    throw new Error(
      "a semantic candidate needs a `decision` provider in config.json"
    )
  }

  return await decideAll({
    adapter: decisions.adapter,
    cache: decisions.cache ?? (await openCache(null)),
    config: decisions.config,
    instructions: candidate.question,
    items,
    mode: decisions.mode ?? "ask",
  })
}

const withConfig = (
  config: Config,
  decisions: DecisionContext
): DecisionContext => {
  const decision = decisions.config ?? config.decision

  const context = { ...decisions }

  if (decision !== undefined) {
    context.config = decision
  }

  return context
}

/** The positive fixture must be flagged; the negative and fixed fixtures must not. A semantic rule flags at or above its cutoff. */
export type Fixtures = {
  valid: boolean
  errorCode: string | null
  detail: string | null
}

export const verifyFixtures = async (
  candidate: Candidate,
  limits?: Limits,
  decisions: DecisionContext = {}
): Promise<Fixtures> => {
  const files = Object.entries(candidate.fixtures).map(([name, source]) => ({
    id: `${name}.ts`,
    source,
  }))

  const result = await evaluate(candidate, files, limits)

  if (result.status === "invalid") {
    return {
      detail: result.detail ?? null,
      errorCode: result.errorCode,
      valid: false,
    }
  }

  let flagged = result.affected
  let detail = `flagged: ${flagged.join(", ") || "nothing"}`

  if (candidate.kind === "semantic") {
    const sources = new Map(files.map((file) => [file.id, file.source]))

    const items = result.diagnostics.map((diagnostic, index) => ({
      key: String(index),
      snippet: snippetFor(
        sources.get(diagnostic.id) ?? "",
        diagnostic,
        candidate.context
      ),
    }))

    const outcome = await decisionsFor(candidate, items, decisions)

    if (outcome.skipped.replayMiss) {
      return {
        detail: "fixture decisions are missing from the cache",
        errorCode: "fixture-undecided",
        valid: false,
      }
    }

    const probability = (index: number) =>
      outcome.probabilities.get(String(index)) ?? 0

    flagged = [
      ...new Set(
        result.diagnostics.flatMap((diagnostic, index) =>
          probability(index) >= candidate.cutoff ? [diagnostic.id] : []
        )
      ),
    ]
    detail = `highest probability per fixture: ${JSON.stringify(
      Object.fromEntries(
        files.map((file) => [
          file.id,
          Math.max(
            0,
            ...result.diagnostics.flatMap((diagnostic, index) =>
              diagnostic.id === file.id ? [probability(index)] : []
            )
          ),
        ])
      )
    )}`
  }

  return flagged.includes("positive.ts") &&
    !flagged.includes("negative.ts") &&
    !flagged.includes("fixed.ts")
    ? { detail: null, errorCode: null, valid: true }
    : { detail, errorCode: "fixture-expectation-mismatch", valid: false }
}

const finding = (
  file: SourceFile,
  line: number,
  column: number,
  probability?: number
): Finding => {
  const lines = file.source.split(/\r\n|\r|\n/u)
  const start = Math.max(0, line - 2)

  const result: Finding = {
    column,
    excerpt: lines
      .slice(start, start + 4)
      .map((text) => text.slice(0, 200))
      .join("\n"),
    line,
    path: file.path,
  }

  if (probability !== undefined) {
    result.probability = probability
  }

  return result
}

const keyOf = (diagnostic: Diagnostic) =>
  `${diagnostic.id}:${diagnostic.line}:${diagnostic.column}`

const cutoffs = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95]

/** Run one candidate over every configured repository's current source. Any failed repository invalidates the measurement. */
export const measure = async (
  config: Config,
  input: unknown,
  decisions: DecisionContext = {}
): Promise<Measurement> => {
  const candidate = parseCandidate(input)
  const context = withConfig(config, decisions)
  const fixtures = await verifyFixtures(candidate, config.limits, context)

  const evaluated: {
    label: string
    eligible: number
    files: SourceFile[]
    diagnostics: Diagnostic[]
    durationMs: number
  }[] = []

  const sources = await readRepositories(config)

  const evaluateNext = async (index: number): Promise<Measurement | null> => {
    const repository = sources[index]

    if (repository === undefined) {
      return null
    }

    const started = performance.now()
    const result = await evaluate(candidate, repository.files, config.limits)

    if (result.status === "invalid") {
      return {
        candidate,
        codebaseFindings: [],
        contrast: null,
        detail: result.detail ?? null,
        errorCode: `${repository.label}: ${result.errorCode}`,
        fixtures,
        referenceExamples: {},
        repositories: [],
        semantic: null,
        status: "invalid",
      }
    }

    evaluated.push({
      diagnostics: [...result.diagnostics].toSorted(
        (a, b) =>
          a.id.localeCompare(b.id) || a.line - b.line || a.column - b.column
      ),
      durationMs: Math.round(performance.now() - started),
      eligible: repository.eligible,
      files: repository.files,
      label: repository.label,
    })

    return await evaluateNext(index + 1)
  }

  const failure = await evaluateNext(0)

  if (failure !== null) {
    return failure
  }

  let probabilities = new Map<string, number>()
  let semantic: Semantic | null = null

  if (candidate.kind === "semantic") {
    if (context.config === undefined) {
      throw new Error(
        "a semantic candidate needs a `decision` provider in config.json"
      )
    }

    const items = evaluated.flatMap((repository) => {
      const files = new Map(repository.files.map((file) => [file.id, file]))

      return repository.diagnostics.map((diagnostic) => ({
        key: keyOf(diagnostic),
        snippet: snippetFor(
          files.get(diagnostic.id)?.source ?? "",
          diagnostic,
          candidate.context
        ),
      }))
    })

    const { probabilities: answered, ...outcome } = await decisionsFor(
      candidate,
      items,
      context
    )

    probabilities = answered

    const rateAt = (cutoff: number) =>
      Object.fromEntries(
        evaluated.map((repository) => {
          const affected = new Set(
            repository.diagnostics
              .filter(
                (diagnostic) =>
                  cutoff === 0 ||
                  (probabilities.get(keyOf(diagnostic)) ?? -1) >= cutoff
              )
              .map((diagnostic) => diagnostic.id)
          )

          return [
            repository.label,
            repository.files.length
              ? affected.size / repository.files.length
              : 0,
          ]
        })
      )

    const curve = cutoffs.map((cutoff) => {
      const rates = rateAt(cutoff)

      const [first, ...rest] = evaluated.map(
        (repository) => rates[repository.label] ?? 0
      )

      return { cutoff, difference: (first ?? 0) - Math.max(0, ...rest), rates }
    })

    const [best] = curve
      .filter(
        (point) =>
          point.cutoff > 0 &&
          evaluated
            .slice(1)
            .every((repository) => (point.rates[repository.label] ?? 0) <= 0.02)
      )
      .toSorted((a, b) => b.difference - a.difference)

    semantic = {
      bestCutoff: best?.cutoff ?? null,
      candidates: Object.fromEntries(
        evaluated.map((repository) => [
          repository.label,
          repository.diagnostics.length,
        ])
      ),
      curve,
      decisions: outcome,
      estimate: estimate(
        context.config,
        candidate.question,
        items.map((item) => item.snippet)
      ),
    }
  }

  const probability = (diagnostic: Diagnostic) =>
    candidate.kind === "semantic"
      ? probabilities.get(keyOf(diagnostic))
      : undefined

  const kept = (diagnostic: Diagnostic) =>
    candidate.kind !== "semantic" ||
    (probability(diagnostic) ?? -1) >= candidate.cutoff

  const repositories: RepositoryResult[] = []
  const codebaseFindings: Finding[] = []
  const referenceExamples: Record<string, Finding[]> = {}

  for (const [index, repository] of evaluated.entries()) {
    const files = new Map(repository.files.map((file) => [file.id, file]))
    const diagnostics = repository.diagnostics.filter(kept)

    if (index === 0) {
      for (const diagnostic of diagnostics) {
        const file = files.get(diagnostic.id)

        if (file) {
          codebaseFindings.push(
            finding(
              file,
              diagnostic.line,
              diagnostic.column,
              probability(diagnostic)
            )
          )
        }
      }
    } else {
      const seen = new Set<string>()
      const examples: Finding[] = []

      for (const diagnostic of diagnostics) {
        const file = files.get(diagnostic.id)

        if (!file || seen.has(file.id) || examples.length >= 5) {
          continue
        }

        seen.add(file.id)
        examples.push(
          finding(
            file,
            diagnostic.line,
            diagnostic.column,
            probability(diagnostic)
          )
        )
      }

      referenceExamples[repository.label] = examples
    }

    const affected = new Set(diagnostics.map((diagnostic) => diagnostic.id))
      .size

    repositories.push({
      affected,
      durationMs: repository.durationMs,
      eligible: repository.eligible,
      files: repository.files.length,
      findings: diagnostics.length,
      label: repository.label,
      rate: repository.files.length ? affected / repository.files.length : 0,
    })
  }

  return {
    candidate,
    codebaseFindings,
    contrast: contrast(repositories),
    detail: null,
    errorCode: null,
    fixtures,
    referenceExamples,
    repositories,
    semantic,
    status: "valid",
  }
}

const contrast = ([
  codebase,
  ...references
]: RepositoryResult[]): Contrast | null => {
  if (!codebase) {
    return null
  }

  const maxReferenceRate = Math.max(
    0,
    ...references.map((reference) => reference.rate)
  )

  return {
    codebaseRate: codebase.rate,
    difference: codebase.rate - maxReferenceRate,
    maxReferenceRate,
    ratios: Object.fromEntries(
      references.map((reference) => [
        reference.label,
        reference.rate === 0 ? null : codebase.rate / reference.rate,
      ])
    ),
  }
}

/** Review labels for one rule's codebase findings; they calibrate semantic rules. */
export const LabelsSchema = z.strictObject({
  labels: z.array(
    z.strictObject({
      label: z.enum(["real", "acceptable", "false-positive"]),
      line: z.number().int().positive(),
      note: z.string().optional(),
      path: z.string(),
    })
  ),
  rule: z.string(),
})

/**
 * Score a semantic candidate against labeled codebase findings: at each cutoff, how many labeled real findings it flags
 * (recall) and how many of its labeled flags are real (precision). A label matches a candidate when its line falls
 * inside the candidate's node.
 */
export const calibrate = async (
  config: Config,
  input: unknown,
  labelSets: z.infer<typeof LabelsSchema>[],
  decisions: DecisionContext = {}
) => {
  const candidate = parseCandidate(input)

  if (candidate.kind !== "semantic") {
    throw new Error("calibrate needs a semantic candidate")
  }

  const context = withConfig(config, decisions)

  const [codebase] = await readRepositories({
    ...config,
    references: [],
    repositories: config.repositories.slice(0, 1),
  })

  if (!codebase) {
    throw new Error("no codebase repository")
  }

  const result = await evaluate(candidate, codebase.files, config.limits)

  if (result.status === "invalid") {
    throw new Error(
      `selector failed: ${result.errorCode} ${result.detail ?? ""}`
    )
  }

  const files = new Map(codebase.files.map((file) => [file.id, file]))

  const items = result.diagnostics.map((diagnostic, index) => ({
    key: String(index),
    snippet: snippetFor(
      files.get(diagnostic.id)?.source ?? "",
      diagnostic,
      candidate.context
    ),
  }))

  const outcome = await decisionsFor(candidate, items, context)

  const probability = (index: number) =>
    outcome.probabilities.get(String(index)) ?? -1

  const labels = labelSets.flatMap((set) => set.labels)

  const matched = labels.map((label) => {
    const hits = result.diagnostics.flatMap((diagnostic, index) =>
      files.get(diagnostic.id)?.path === label.path &&
      diagnostic.line <= label.line &&
      label.line <= diagnostic.endLine
        ? [probability(index)]
        : []
    )

    return { ...label, probability: hits.length ? Math.max(...hits) : null }
  })

  const real = matched.filter((label) => label.label === "real").length

  const points = cutoffs.flatMap((cutoff) => {
    if (cutoff <= 0) {
      return []
    }

    const flagged = matched.filter(
      (label) => label.probability !== null && label.probability >= cutoff
    )

    const truePositives = flagged.filter(
      (label) => label.label === "real"
    ).length

    return [
      {
        acceptable: flagged.filter((label) => label.label === "acceptable")
          .length,
        cutoff,
        falsePositive: flagged.filter(
          (label) => label.label === "false-positive"
        ).length,
        flaggedLabeled: flagged.length,
        flaggedTotal: result.diagnostics.filter(
          (_, index) => probability(index) >= cutoff
        ).length,
        precision: flagged.length ? truePositives / flagged.length : null,
        real: truePositives,
        recall: real ? truePositives / real : null,
      },
    ]
  })

  return {
    answeredBy: outcome.models,
    candidate: candidate.id,
    labels: labels.length,
    matched,
    model: context.config?.model,
    points,
    provider: context.config?.provider,
    selectorMissed: matched.filter((label) => label.probability === null)
      .length,
  }
}

/** Search the installed-rule catalog: configured rules first, with option schemas for an exact name. */
export const searchRules = async (config: Config, query: string) => {
  if (
    config.ruleCatalogFile === undefined ||
    config.ruleCatalogFile.length === 0
  ) {
    throw new Error("ruleCatalogFile is not configured")
  }

  const catalog = RuleCatalogSchema.parse(
    await readJson(config.ruleCatalogFile)
  )

  const fresh = await verifyCatalog(catalog).then(
    (result) => result.verified,
    () => false
  )

  const needle = query.toLowerCase()

  const rules = catalog.rules
    .filter((rule) =>
      `${rule.name} ${rule.summary}`.toLowerCase().includes(needle)
    )
    .toSorted(
      (a, b) =>
        Number(b.name === needle) - Number(a.name === needle) ||
        Number(b.configured) - Number(a.configured) ||
        a.name.localeCompare(b.name)
    )
    .slice(0, 20)
    .map((rule) => {
      const match: {
        configuration: typeof rule.configuration
        configured: boolean
        name: string
        summary: string
        optionsSchema?: string
      } = {
        configuration: rule.configuration,
        configured: rule.configured,
        name: rule.name,
        summary: rule.summary,
      }

      if (rule.name === needle) {
        match.optionsSchema = JSON.stringify(rule.optionsSchema).slice(0, 8000)
      }

      return match
    })

  return { engine: catalog.engine, fresh, rules, version: catalog.version }
}

export const summary = (measurement: Measurement, shown: number) => ({
  ...measurement,
  codebaseFindings: measurement.codebaseFindings.slice(0, shown),
  codebaseFindingsOmitted: Math.max(
    0,
    measurement.codebaseFindings.length - shown
  ),
})
