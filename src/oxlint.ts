import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { z } from "zod"

import { runFile } from "./process.ts"

/** A built-in Oxlint rule, as `rule` (ESLint core) or `plugin/rule`. Type-aware rules do not run here. */
export const BuiltinRuleSchema = z
  .string()
  .regex(/^(?:[a-z][a-z0-9-]*\/)?[a-z][a-z0-9-]*$/u)

/** A candidate plugin rule's name; it runs as `candidate/<name>`. */
export const PluginRuleSchema = z.string().regex(/^[a-z][a-z0-9-]*$/u)

type Json = z.infer<ReturnType<typeof z.json>>

export const engineVersion = "1.87.0"

export const limitsSchema = z.strictObject({
  maxDiagnostics: z.number().int().min(1).max(1_000_000).default(100_000),
  totalMs: z.number().int().min(1).max(600_000).default(120_000),
})

/** One-based positions; columns count UTF-16 code units. `message` is the rule's own text. */
export type Diagnostic = {
  id: string
  line: number
  column: number
  endLine: number
  endColumn: number
  message: string
}

export type EvaluationResult =
  | { status: "valid"; affected: string[]; diagnostics: Diagnostic[] }
  | {
      status: "invalid"
      errorCode:
        | "invalid-input"
        | "parse-error"
        | "rule-error"
        | "invalid-diagnostics"
        | "resource-limit"
      detail?: string
    }

const requestSchema = z.strictObject({
  files: z
    .array(z.strictObject({ id: z.string().min(1), source: z.string() }))
    .max(10_000),
  limits: limitsSchema.default(() => limitsSchema.parse({})),
  options: z.array(z.json()).max(20),
  plugin: z.string().min(1).max(200_000).optional(),
  rule: z.string(),
})

const outputSchema = z.object({
  diagnostics: z.array(
    z.object({
      code: z.string().optional(),
      filename: z.string(),
      labels: z.array(
        z.object({
          span: z.object({
            column: z.number().int().positive(),
            length: z.number().int().nonnegative(),
            line: z.number().int().positive(),
            offset: z.number().int().nonnegative(),
          }),
        })
      ),
      message: z.string().optional(),
      severity: z.literal("error"),
    })
  ),
  number_of_files: z.number().int().nonnegative(),
})

type Request = {
  rule: string
  options: readonly Json[]
  plugin?: string
  files: readonly { id: string; source: string }[]
  limits?: Partial<z.infer<typeof limitsSchema>>
}

const execute = async (
  engine: string,
  args: string[],
  directory: string,
  timeout: number
) => {
  try {
    const output = await runFile(process.execPath, [engine, ...args], {
      cwd: directory,
      encoding: "utf-8",
      env: {
        HOME: directory,
        NAPI_RS_ENFORCE_VERSION_CHECK: "1",
        PATH: "/usr/bin:/bin",
        TMPDIR: directory,
      },
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 * 1024,
      timeout: Math.max(1, timeout),
    })

    return { ...output, code: 0, limited: false }
  } catch (error) {
    const output = z
      .object({
        code: z.union([z.string(), z.number()]).nullable().optional(),
        killed: z.boolean().optional(),
        stderr: z.string(),
        stdout: z.string(),
      })
      .parse(error)

    return {
      code: typeof output.code === "number" ? output.code : null,
      limited:
        output.killed === true ||
        output.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      stderr: output.stderr,
      stdout: output.stdout,
    }
  }
}

/**
 * Run one rule in the bundled Oxlint over staged copies of the files, with only that rule enabled. A built-in rule is named
 * directly; a candidate plugin rule is an ES module whose default export is an ESLint-style rule (`{ meta, create(context) }`),
 * the same shape as the repository's own `tools/oxlint` rules.
 */
export const evaluateRule = async (
  input: Request
): Promise<EvaluationResult> => {
  const started = performance.now()
  const parsed = requestSchema.safeParse(input)

  if (!parsed.success) {
    return { errorCode: "invalid-input", status: "invalid" }
  }

  const request = parsed.data

  if (
    !(
      request.plugin === undefined ? BuiltinRuleSchema : PluginRuleSchema
    ).safeParse(request.rule).success
  ) {
    return { errorCode: "invalid-input", status: "invalid" }
  }

  if (
    new Set(request.files.map((file) => file.id)).size !== request.files.length
  ) {
    return { errorCode: "invalid-input", status: "invalid" }
  }

  if (
    request.files.reduce(
      (bytes, file) => bytes + Buffer.byteLength(file.source),
      0
    ) >
    128 * 1024 * 1024
  ) {
    return { errorCode: "resource-limit", status: "invalid" }
  }

  if (!request.files.length) {
    return { affected: [], diagnostics: [], status: "valid" }
  }

  let directory: string | undefined

  try {
    const root = await realpath(
      path.join(import.meta.dirname, "../node_modules/oxlint")
    )

    const metadata = z
      .object({ version: z.literal(engineVersion) })
      .safeParse(
        JSON.parse(await readFile(path.join(root, "package.json"), "utf-8"))
      )

    if (!metadata.success) {
      return {
        detail: `bundled oxlint is not ${engineVersion}`,
        errorCode: "invalid-input",
        status: "invalid",
      }
    }

    directory = await mkdtemp(path.join(tmpdir(), "lrf-oxlint-"))
    const stagingDirectory = directory
    const deadline = started + request.limits.totalMs
    const files = new Map<string, { id: string; source: string }>()

    const stage = async (index: number): Promise<EvaluationResult | null> => {
      const file = request.files[index]

      if (file === undefined) {
        return null
      }

      if (performance.now() >= deadline) {
        return { errorCode: "resource-limit", status: "invalid" }
      }

      const filename = path.join(
        stagingDirectory,
        `file-${String(index).padStart(5, "0")}.${file.id.endsWith(".tsx") ? "tsx" : "ts"}`
      )

      await writeFile(filename, file.source, { mode: 0o600 })
      files.set(filename, file)

      return await stage(index + 1)
    }

    const stageFailure = await stage(0)

    if (stageFailure !== null) {
      return stageFailure
    }

    const builtinPlugin =
      request.plugin === undefined && request.rule.includes("/")
        ? request.rule.slice(0, request.rule.indexOf("/"))
        : null

    const jsPlugins: { name: string; specifier: string }[] = []

    if (request.plugin !== undefined) {
      await writeFile(path.join(directory, "rule.mjs"), request.plugin, {
        mode: 0o600,
      })
      await writeFile(
        path.join(directory, "plugin.mjs"),
        `import rule from "./rule.mjs";\nexport default { meta: { name: "candidate" }, rules: { ${JSON.stringify(request.rule)}: rule } };\n`,
        { mode: 0o600 }
      )
      jsPlugins.push({
        name: "candidate",
        specifier: path.join(directory, "plugin.mjs"),
      })
    }

    const enabled =
      request.plugin === undefined ? request.rule : `candidate/${request.rule}`

    const config = path.join(directory, "config.json")
    const tsconfig = path.join(directory, "tsconfig.json")

    await writeFile(
      config,
      JSON.stringify({
        categories: Object.fromEntries(
          [
            "correctness",
            "suspicious",
            "pedantic",
            "perf",
            "style",
            "restriction",
            "nursery",
          ].map((name) => [name, "off"])
        ),
        extends: [],
        jsPlugins,
        options: {
          respectEslintDisableDirectives: true,
          typeAware: false,
          typeCheck: false,
        },
        plugins:
          builtinPlugin === null || builtinPlugin === "eslint"
            ? []
            : [builtinPlugin],
        rules: { [enabled]: ["error", ...request.options] },
      }),
      { mode: 0o600 }
    )
    await writeFile(
      tsconfig,
      JSON.stringify({
        compilerOptions: {
          noEmit: true,
          noLib: true,
          noResolve: true,
          types: [],
        },
        include: ["*.ts", "*.tsx"],
      }),
      { mode: 0o600 }
    )
    const diagnostics: Diagnostic[] = []
    const sourceBytes = new Map<string, Buffer>()
    const paths = [...files.keys()]
    // Oxlint reports codes such as `eslint(max-depth)` or `candidate(my-rule)`; only this rule is enabled.
    const expected = `(${request.rule.slice(request.rule.indexOf("/") + 1)})`

    const convertDiagnostic = (
      diagnostic: z.infer<typeof outputSchema>["diagnostics"][number],
      filename: string,
      file: { id: string; source: string },
      span: z.infer<
        typeof outputSchema
      >["diagnostics"][number]["labels"][number]["span"]
    ): Diagnostic | null => {
      let bytes = sourceBytes.get(filename)

      if (!bytes) {
        bytes = Buffer.from(file.source)
        sourceBytes.set(filename, bytes)
      }

      if (span.offset + span.length > bytes.length) {
        return null
      }

      const prefix = bytes.subarray(0, span.offset).toString("utf-8")

      if (Buffer.byteLength(prefix) !== span.offset) {
        return null
      }

      const lines = prefix.split(/\r\n|[\r\n\u2028\u2029]/u)

      if (span.line !== lines.length) {
        return null
      }

      const through = bytes
        .subarray(0, span.offset + span.length)
        .toString("utf-8")
        .split(/\r\n|[\r\n\u2028\u2029]/u)

      return {
        column: (lines.at(-1)?.length ?? 0) + 1,
        endColumn: (through.at(-1)?.length ?? 0) + 1,
        endLine: through.length,
        id: file.id,
        line: lines.length,
        message: diagnostic.message ?? "",
      }
    }

    const appendDiagnostic = (
      diagnostic: z.infer<typeof outputSchema>["diagnostics"][number],
      selected: Set<string>
    ): EvaluationResult | null => {
      if (performance.now() >= deadline) {
        return { errorCode: "resource-limit", status: "invalid" }
      }

      // A diagnostic without a code is a parse failure or, for a plugin rule, an exception thrown while linting.
      if (diagnostic.code === undefined || diagnostic.code.length === 0) {
        return {
          detail: (diagnostic.message ?? JSON.stringify(diagnostic)).slice(
            0,
            4000
          ),
          errorCode:
            diagnostic.message?.startsWith("Error running JS plugin") === true
              ? "rule-error"
              : "parse-error",
          status: "invalid",
        }
      }

      if (!diagnostic.code.endsWith(expected)) {
        return {
          detail: JSON.stringify(diagnostic).slice(0, 4000),
          errorCode: "rule-error",
          status: "invalid",
        }
      }

      const filename = path.resolve(stagingDirectory, diagnostic.filename)
      const file = files.get(filename)
      const span = diagnostic.labels[0]?.span

      if (!selected.has(filename) || !file || !span) {
        return { errorCode: "invalid-diagnostics", status: "invalid" }
      }

      const converted = convertDiagnostic(diagnostic, filename, file, span)

      if (converted === null) {
        return { errorCode: "invalid-diagnostics", status: "invalid" }
      }

      diagnostics.push(converted)

      if (diagnostics.length > request.limits.maxDiagnostics) {
        return { errorCode: "resource-limit", status: "invalid" }
      }

      return null
    }

    const runBatch = async (
      offset: number
    ): Promise<EvaluationResult | null> => {
      if (offset >= paths.length) {
        return null
      }

      if (performance.now() >= deadline) {
        return { errorCode: "resource-limit", status: "invalid" }
      }

      const batch = paths.slice(offset, offset + 150)
      const selected = new Set(batch)

      const outcome = await execute(
        path.join(root, "bin/oxlint"),
        [
          "--config",
          config,
          "--tsconfig",
          tsconfig,
          "--disable-nested-config",
          "--no-ignore",
          "--threads",
          "1",
          "--format",
          "json",
          ...batch,
        ],
        stagingDirectory,
        Math.ceil(deadline - performance.now())
      )

      if (outcome.limited || performance.now() >= deadline) {
        return { errorCode: "resource-limit", status: "invalid" }
      }

      if (outcome.stderr || (outcome.code !== 0 && outcome.code !== 1)) {
        return {
          detail: (outcome.stderr || outcome.stdout).slice(0, 4000),
          errorCode: "rule-error",
          status: "invalid",
        }
      }

      const output = outputSchema.safeParse(JSON.parse(outcome.stdout))

      if (!output.success || output.data.number_of_files !== batch.length) {
        return { errorCode: "invalid-diagnostics", status: "invalid" }
      }

      if (outcome.code === 1 && output.data.diagnostics.length === 0) {
        return {
          detail: outcome.stdout.slice(0, 4000),
          errorCode: "rule-error",
          status: "invalid",
        }
      }

      for (const diagnostic of output.data.diagnostics) {
        const failure = appendDiagnostic(diagnostic, selected)

        if (failure !== null) {
          return failure
        }
      }

      return await runBatch(offset + 150)
    }

    const batchFailure = await runBatch(0)

    if (batchFailure !== null) {
      return batchFailure
    }

    if (performance.now() >= deadline) {
      return { errorCode: "resource-limit", status: "invalid" }
    }

    return {
      affected: [...new Set(diagnostics.map((diagnostic) => diagnostic.id))],
      diagnostics,
      status: "valid",
    }
  } catch (error) {
    return {
      detail: String(error).slice(0, 4000),
      errorCode: "rule-error",
      status: "invalid",
    }
  } finally {
    if (directory !== undefined) {
      await rm(directory, { force: true, recursive: true }).catch(
        () => undefined
      )
    }
  }
}
