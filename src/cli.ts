#!/usr/bin/env node
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"

import { buildCatalog } from "./catalog.ts"
import { loadConfig } from "./corpus.ts"
import { decideAll, openCache } from "./decide.ts"
import {
  calibrate,
  LabelsSchema,
  measure,
  searchRules,
  summary,
} from "./measure.ts"
import type { DecisionContext } from "./measure.ts"
import { DecisionConfigSchema, readJson, writeJson } from "./model.ts"
import { syncReferences } from "./references.ts"

const [command = "", ...rest] = process.argv.slice(2)

const flag = (name: string): string | undefined => {
  const index = rest.indexOf(name)

  return index === -1 ? undefined : rest[index + 1]
}

const required = (name: string): string => {
  const value = flag(name)

  if (value === undefined || value === "") {
    throw new Error(`${name} is required`)
  }

  return value
}

const print = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

if (existsSync(".env.local")) {
  process.loadEnvFile(".env.local")
}

if (command === "catalog") {
  const result = await buildCatalog({
    config: required("--trusted-config"),
    engine: required("--engine"),
    output: required("--output"),
    schema: required("--schema"),
  })

  print({
    configured: result.rules.filter((rule) => rule.configured).length,
    engine: result.engine,
    rules: result.rules.length,
    version: result.version,
  })
} else {
  const configPath = required("--config")
  const config = await loadConfig(configPath)

  if (command === "references") {
    print(await syncReferences(config))
  } else {
    const provider = flag("--provider")
    const model = flag("--model")
    let { decision } = config

    if (provider !== undefined || model !== undefined) {
      decision = DecisionConfigSchema.parse({
        ...decision,
        model: model ?? decision?.model,
        provider: provider ?? decision?.provider,
      })
    }

    const cache = await openCache(
      flag("--cache") ??
        path.join(
          path.dirname(path.resolve(configPath)),
          "decisions.cache.json"
        )
    )

    const decisions: DecisionContext = {
      cache,
      mode: rest.includes("--replay") ? "replay" : "ask",
    }

    if (decision !== undefined) {
      decisions.config = decision
    }

    switch (command) {
      case "rule": {
        const measurement = await measure(
          config,
          await readJson(required("--candidate")),
          decisions
        )

        const out = flag("--out")

        if (out !== undefined) {
          await writeJson(out, measurement)
        }

        print(summary(measurement, 30))

        if (measurement.status === "invalid" || !measurement.fixtures.valid) {
          process.exitCode = 1
        }

        break
      }

      case "rules": {
        print(await searchRules(config, flag("--query") ?? ""))
        break
      }

      case "decide": {
        const question = required("--question")
        const file = required("--file")

        if (decision === undefined) {
          throw new Error(
            "decide needs a decision provider and model in config or --provider and --model"
          )
        }

        const [filePath = file, range] = file.split(":")
        const source = await readFile(filePath, "utf-8")
        const lines = source.split(/\r\n|\r|\n/u)

        const [from = 1, to = lines.length] =
          range === undefined ? [] : range.split("-").map(Number)

        const outcome = await decideAll({
          cache,
          config: decision,
          instructions: question,
          items: [
            { key: "snippet", snippet: lines.slice(from - 1, to).join("\n") },
          ],
          mode: decisions.mode ?? "ask",
        })

        print({
          answeredBy: outcome.models,
          cached: outcome.cached > 0,
          file: path.relative(process.cwd(), path.resolve(filePath)),
          lines: [from, to],
          model: decision.model,
          probability: outcome.probabilities.get("snippet") ?? null,
          provider: decision.provider,
        })
        break
      }

      case "calibrate": {
        const labelPaths = rest.filter(
          (_, index) => rest[index - 1] === "--labels"
        )

        if (labelPaths.length === 0) {
          throw new Error("calibrate needs at least one --labels FILE")
        }

        const sets = await Promise.all(
          labelPaths.map(async (file) =>
            LabelsSchema.parse(await readJson(file))
          )
        )

        const result = await calibrate(
          config,
          await readJson(required("--candidate")),
          sets,
          decisions
        )

        const out = flag("--out")

        if (out !== undefined) {
          await writeJson(out, result)
        }

        print({ ...result, matched: undefined })
        break
      }

      default: {
        throw new Error(
          "expected rule, rules, decide, calibrate, catalog or references"
        )
      }
    }
  }
}
