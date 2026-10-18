import type { ExecFileOptionsWithStringEncoding } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { boolean, decide } from "@tanstack/ai"
import type { AnyEvaluateAdapter } from "@tanstack/ai"
import { z } from "zod"

import { writeJson } from "./model.ts"
import type { DecisionConfig } from "./model.ts"
import { runFile } from "./process.ts"

const wireAnswerSchema = z.discriminatedUnion("type", [
  z.object({ noul: z.number(), type: z.literal("noul") }),
  z.object({
    choice: z.string(),
    confidence: z.number(),
    probabilities: z.record(z.string(), z.number()),
    type: z.literal("choice"),
  }),
  z.object({
    confidence: z.number(),
    legend: z.record(z.string(), z.string()),
    probabilities: z.record(z.string(), z.number()),
    score: z.number(),
    type: z.literal("score"),
  }),
])

/**
 * Workers AI through the logged-in `cf` CLI (`cf ai run MODEL --body @FILE`), so no API token is handled here. Clef's
 * schema requires its short model name in the body; other models get the body as TanStack AI builds it.
 */
export const cfCliDecider = (model: string): AnyEvaluateAdapter => {
  const clef = /\/(?<model>clef(?:-flash)?)$/u.exec(model)?.groups?.model

  return {
    evaluate: async ({ state, questions, abortSignal }) => {
      const directory = await mkdtemp(path.join(tmpdir(), "lrf-cf-"))

      try {
        const body = path.join(directory, "body.json")

        const payload: {
          model?: string
          questions: typeof questions
          state: typeof state
        } = { questions, state }

        if (clef !== undefined) {
          payload.model = clef
        }

        await writeFile(body, JSON.stringify(payload), { mode: 0o600 })

        const options: ExecFileOptionsWithStringEncoding = {
          encoding: "utf-8",
          maxBuffer: 16 * 1024 * 1024,
          signal: abortSignal,
        }

        const { stdout } = await runFile(
          "cf",
          ["ai", "run", model, "--body", `@${body}`, "-q"],
          options
        ).catch((error: unknown) => {
          const failure = z
            .object({ message: z.string(), stderr: z.string().optional() })
            .parse(error)

          throw new Error(
            `cf ai run failed: ${((failure.stderr ?? "").length > 0 ? (failure.stderr ?? "") : failure.message).trim().slice(0, 2000)}`
          )
        })

        const output = z
          .object({
            answers: z.record(z.string(), wireAnswerSchema),
            model: z.string(),
            usage: z
              .object({ input_tokens: z.number(), output_tokens: z.number() })
              .optional(),
          })
          .parse(JSON.parse(stdout))

        const input = output.usage?.input_tokens ?? 0
        const completion = output.usage?.output_tokens ?? 0

        return {
          answers: output.answers,
          model: output.model,
          usage: {
            completionTokens: completion,
            promptTokens: input,
            totalTokens: input + completion,
          },
        }
      } finally {
        await rm(directory, { force: true, recursive: true })
      }
    },
    kind: "evaluate",
    model,
    name: "cf-cli",
    "~types": { providerOptions: {} },
  }
}

/** Load the adapter lazily so only the configured provider's package is imported. */
export const adapterFor = async (
  config: DecisionConfig
): Promise<AnyEvaluateAdapter> => {
  switch (config.provider) {
    case "cf-cli": {
      return cfCliDecider(config.model)
    }

    case "cloudflare": {
      const { cloudflareDecider } = await import("@tanstack/ai-cloudflare")

      return cloudflareDecider(config.model)
    }

    case "typesafe": {
      const { typesafeDecider } = await import("@tanstack/ai-typesafe")

      return typesafeDecider(config.model)
    }

    case "openai": {
      const { openaiDecider } = await import("@tanstack/ai-openai")

      return openaiDecider(config.model)
    }

    case "openrouter": {
      const { openRouterDecider } = await import("@tanstack/ai-openrouter")

      return openRouterDecider(config.model)
    }

    case "ollaya": {
      const { ollayaDecider } = await import("@tanstack/ai-ollaya")

      return ollayaDecider(config.model)
    }

    default: {
      const exhaustive: never = config.provider

      return exhaustive
    }
  }
}

/**
 * Answers keyed by provider, configured model, question and snippet, so a question is asked once per input. The answering
 * model version is stored with each answer. The same file format serves as a run cache and as a committed lockfile.
 */
const CacheSchema = z.strictObject({
  entries: z.record(
    z.string(),
    z.strictObject({ model: z.string(), probability: z.number().min(0).max(1) })
  ),
  version: z.literal(1),
})

export type DecisionCache = {
  path: string | null
  entries: Map<string, { probability: number; model: string }>
}

export const openCache = async (
  cachePath: string | null
): Promise<DecisionCache> => {
  if (cachePath === null) {
    return { entries: new Map(), path: cachePath }
  }

  const cachedText = await readFile(cachePath, "utf-8").catch(
    (error: unknown) => {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null
      }

      throw error
    }
  )

  return {
    entries: new Map(
      cachedText === null
        ? []
        : Object.entries(CacheSchema.parse(JSON.parse(cachedText)).entries)
    ),
    path: cachePath,
  }
}

const saveCache = async (cache: DecisionCache): Promise<void> => {
  if (cache.path === null) {
    return
  }

  const entries = Object.fromEntries(
    [...cache.entries].toSorted(([a], [b]) => a.localeCompare(b))
  )

  await writeJson(cache.path, { entries, version: 1 })
}

export const decisionKey = (
  config: DecisionConfig,
  instructions: string,
  snippet: string
): string =>
  createHash("sha256")
    .update(
      JSON.stringify([config.provider, config.model, instructions, snippet])
    )
    .digest("hex")

/** Snippets that look like they contain credentials are never sent. */
const secretPattern =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|\bsk-[A-Za-z0-9_-]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bgh[pousr]_[A-Za-z0-9]{30,}/u

export type DecisionItem = { key: string; snippet: string }

export type DecisionOutcome = {
  probabilities: Map<string, number>
  asked: number
  cached: number
  skipped: { secret: number; replayMiss: number }
  models: string[]
  inputTokens: number
}

/**
 * Ask one yes/no question about many snippets. Each request carries up to `snippetsPerRequest` snippets as
 * `state.snippets`, with one boolean question per snippet. `mode: "replay"` never calls the provider.
 */
export const decideAll = async ({
  config,
  cache,
  instructions,
  items,
  mode = "ask",
  adapter,
}: {
  config: DecisionConfig
  cache: DecisionCache
  instructions: string
  items: readonly DecisionItem[]
  mode?: "ask" | "replay"
  adapter?: AnyEvaluateAdapter
}): Promise<DecisionOutcome> => {
  const outcome: DecisionOutcome = {
    asked: 0,
    cached: 0,
    inputTokens: 0,
    models: [],
    probabilities: new Map(),
    skipped: { replayMiss: 0, secret: 0 },
  }

  const models = new Set<string>()

  const pending: { item: DecisionItem; snippet: string; cacheKey: string }[] =
    []

  const seen = new Map<string, string[]>()

  for (const item of items) {
    const snippet =
      item.snippet.length > config.maxSnippetChars
        ? item.snippet.slice(0, config.maxSnippetChars)
        : item.snippet

    if (secretPattern.test(snippet)) {
      outcome.skipped.secret += 1
      continue
    }

    const cacheKey = decisionKey(config, instructions, snippet)
    const hit = cache.entries.get(cacheKey)

    if (hit) {
      outcome.probabilities.set(item.key, hit.probability)
      outcome.cached += 1
      models.add(hit.model)
      continue
    }

    if (mode === "replay") {
      outcome.skipped.replayMiss += 1
      continue
    }

    // Identical snippets are asked once.
    const waiting = seen.get(cacheKey)

    if (waiting) {
      waiting.push(item.key)
      continue
    }

    seen.set(cacheKey, [item.key])
    pending.push({ cacheKey, item, snippet })
  }

  if (pending.length > config.maxDecisions) {
    throw new Error(
      `decision budget exceeded: ${pending.length} new decisions, maxDecisions is ${config.maxDecisions}`
    )
  }

  const resolved =
    adapter ?? (pending.length ? await adapterFor(config) : undefined)

  const batches: (typeof pending)[] = []

  for (
    let index = 0;
    index < pending.length;
    index += config.snippetsPerRequest
  ) {
    batches.push(pending.slice(index, index + config.snippetsPerRequest))
  }

  let next = 0
  const failures: string[] = []

  const worker = async () => {
    if (next < batches.length && failures.length === 0) {
      const batch = batches[next]
      next += 1

      if (!batch || !resolved) {
        return
      }

      const snippets = Object.fromEntries(
        batch.map((entry, index) => [`s${index}`, entry.snippet])
      )

      const questions = Object.fromEntries(
        batch.map((_, index) => [
          `s${index}`,
          boolean({
            instructions: `Consider only snippet s${index} in state.snippets. Code between /*>>*/ and /*<<*/ is the marked code. ${instructions}`,
          }),
        ])
      )

      try {
        const result = await decide({
          abortSignal: AbortSignal.timeout(config.timeoutMs),
          adapter: resolved,
          questions,
          state: { snippets },
        })

        const answers = result

        models.add(answers.meta.model)
        outcome.inputTokens += answers.meta.usage?.promptTokens ?? 0

        for (const [index, entry] of batch.entries()) {
          const probability = answers[`s${index}`]?.probability

          if (typeof probability !== "number") {
            throw new TypeError(`no probability for snippet s${index}`)
          }

          cache.entries.set(entry.cacheKey, {
            model: answers.meta.model,
            probability,
          })

          for (const key of seen.get(entry.cacheKey) ?? []) {
            outcome.probabilities.set(key, probability)
          }
        }

        outcome.asked += batch.length
        await saveCache(cache)
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error))
      }

      await worker()
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(config.concurrency, batches.length) }, worker)
  )

  if (outcome.asked) {
    await saveCache(cache)
  }

  outcome.models = [...models].toSorted()

  if (failures.length) {
    throw new Error(`decision provider failed: ${failures[0]}`)
  }

  return outcome
}

/** Rough input-token estimate (characters / 4) for a budget check before any call. */
export const estimate = (
  config: DecisionConfig,
  instructions: string,
  snippets: readonly string[]
) => {
  const tokens = Math.ceil(
    snippets.reduce(
      (sum, snippet) =>
        sum +
        Math.min(snippet.length, config.maxSnippetChars) +
        instructions.length +
        80,
      0
    ) / 4
  )

  return {
    decisions: snippets.length,
    inputTokens: tokens,
    usd:
      config.inputPricePerMillionTokens === undefined
        ? null
        : (tokens / 1_000_000) * config.inputPricePerMillionTokens,
  }
}
