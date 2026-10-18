# inspired-lint

`inspired-lint` measures lint rules against a codebase and reference repositories that its owner considers good code. It helps invent rules for habits that appear in many codebase files and almost no reference files.

The affected-file rate is the number of files with a finding divided by files measured. Rank rules by the codebase rate against the highest reference rate. A useful rule approaches zero in every reference, about 2% or less, while catching a common codebase habit. A rule that matches only the codebase's domain names or layout is a fingerprint. Review must show that the reference's version improves the flagged code.

Discovery invents new plugin rules. The installed-rule catalog prevents duplicate proposals. Deterministic rules come first. A semantic rule adds a decision model only when review cannot separate real and acceptable findings by syntax.

The canonical source is `packages/inspired-lint` in [MatsErdkamp/contractors-effect](https://github.com/MatsErdkamp/contractors-effect).
The standalone `MatsErdkamp/inspired-lint` repository receives a one-way copy of that directory and its relevant Git history.
See [Contributing](CONTRIBUTING.md) for the contribution location and standalone checks.

## Installation

Node 24 or later is required. Git is required to sync pinned references. In this workspace, run these commands from the repository root:

```sh
pnpm install
pnpm --filter inspired-lint check
pnpm --filter inspired-lint test
node packages/inspired-lint/src/cli.ts rules --config .agents/lint-rule-finder/config.json --query schema
```

The package imports no other workspace package. For a standalone checkout, copy this package directory, install its dependencies with `npm install --ignore-scripts`, then run `npm run check` and `npm test`. From that directory, the entry point is `node src/cli.ts`. The workspace-only `lint` script uses the parent repository's lint config. A standalone checkout needs its own lint configuration.

The package manifest remains private, and the package is unpublished on npm. Publishing the Git repository does not publish an npm package.
It pins Oxlint 1.87.0 and checks that engine version at runtime. Before npm publication, the plan is an Oxlint peer dependency with a tested version range.

## Configuration

Configuration is strict JSON, version 3. Unknown fields fail validation. Root paths and the catalog path are absolute. Relative file arguments on the CLI resolve from the working directory.

```json
{
  "version": 3,
  "repositories": [
    { "label": "codebase", "root": "/absolute/path/to/project" }
  ],
  "references": [
    {
      "label": "reference",
      "url": "https://example.com/owner/repository.git",
      "commit": "0123456789abcdef0123456789abcdef01234567"
    }
  ],
  "referenceCacheDirectory": "/absolute/path/to/reference-cache",
  "include": ["packages/**/src/**/*.ts", "packages/**/src/**/*.tsx"],
  "exclude": ["packages/inspired-lint/**"],
  "lanes": [{ "id": "function-shape", "angle": "Compare function and module shape." }],
  "limits": { "totalMs": 120000, "maxDiagnostics": 100000 },
  "ruleCatalogFile": "/absolute/path/to/rule-catalog.json"
}
```

The reference URL and commit above illustrate the shape. Supply a real Git URL and its full commit SHA before syncing.

| Field | Meaning and default |
| --- | --- |
| `version` | Required, exactly `3`. |
| `repositories` | Required nonempty array of `{ label, root }`. The first entry is the codebase. Later entries are local reference checkouts. Entries also accept per-repository `include` and `exclude`. Local measurements include uncommitted source changes. |
| `references` | Optional pinned references appended to `repositories`. Each entry has `label`, `url`, and a full 40-hex `commit`. Optional per-entry `include` replaces global include globs; per-entry `exclude` adds to global excludes. The URL is a Git URL or an absolute local Git repository path. Labels are unique across both arrays. |
| `referenceCacheDirectory` | Optional absolute cache directory. Defaults to `~/.cache/inspired-lint/references`. Each pinned clone is stored under its label. |
| `include` | Optional array of repository-relative Node `path.matchesGlob` patterns. Replaces the default layout predicate. Omitted, selects TypeScript and TSX under the original `packages/.../src/...` layout. |
| `exclude` | Optional array of additional repository-relative exclusion globs. Defaults to none. |
| `lanes` | Required nonempty array of `{ id, angle }`. IDs are unique lowercase slugs. Angles are nonempty descriptions for discovery workers. |
| `limits.totalMs` | Time limit per repository. Defaults to `120000`, integer from 1 through 600000. |
| `limits.maxDiagnostics` | Diagnostic cap per repository. Defaults to `100000`, integer from 1 through 1000000. |
| `maxFilesPerRepository` | Optional positive integer. Selects a stable subset ranked by the hash of each relative path. Omitted, measures all eligible files. |
| `ruleCatalogFile` | Optional absolute catalog path. Required by `rules`. |
| `decision` | Optional provider settings. Required for semantic measurements, calibration, and `decide`, unless the command supplies provider and model overrides. There is no package default provider. |

A repository or pinned reference may override `include` and add `exclude` patterns. This lets different layouts share one config. For example, this project selects only `packages/effect/src/**/*.ts` and `.tsx` in the full Effect clone to match the earlier sparse checkout.

Include globs keep the safety exclusions. The corpus always excludes declarations, test and spec files, and folders named `test`, `tests`, `__tests__`, `fixtures`, `__fixtures__`, `generated`, `__generated__`, `vendor`, `node_modules`, or `.git`. Symlinks never allow selection outside the repository.

### Pinned references

```sh
node packages/inspired-lint/src/cli.ts references --config CONFIG
```

The command clones or updates each pinned reference and checks out its commit with a detached HEAD. Repeating it converges to the same commit. Sync checks the remote URL, refuses dirty or unmanaged cache directories, and disables Git hooks. It runs no reference scripts. Measurement reads pinned clones only after verifying their URL, commit, and clean state. Existing root-based reference entries remain supported.

A reference cache is a local checkout, not a sandbox. Use only references you intend to read and keep candidate plugin code trusted.

### Decision settings

The package has no default provider or model. Set both explicitly:

```json
{
  "provider": "cf-cli",
  "model": "@cf/cloudflare/clef-flash",
  "timeoutMs": 30000,
  "concurrency": 4,
  "snippetsPerRequest": 16,
  "maxSnippetChars": 4000,
  "maxDecisions": 20000,
  "inputPricePerMillionTokens": 0.24
}
```

Place this object under `decision` in the config.

| Field | Meaning and default |
| --- | --- |
| `provider` | Required provider ID from the table below. |
| `model` | Required nonempty model ID. |
| `timeoutMs` | Request timeout. Defaults to `30000`, integer from 1 through 300000. |
| `concurrency` | Concurrent requests. Defaults to `4`, integer from 1 through 32. |
| `snippetsPerRequest` | Boolean questions per request. Defaults to `16`, integer from 1 through 64. |
| `maxSnippetChars` | Maximum snippet length. Defaults to `4000`, integer from 200 through 64000. |
| `maxDecisions` | New-decision budget. Defaults to `20000`, positive integer. Exceeding it stops the run before a provider call. |
| `inputPricePerMillionTokens` | Optional nonnegative input price for estimates. Omitted, the dollar estimate is `null`. |

## Commands

Run the following forms from the workspace root. Commands load `.env.local` from the caller's working directory when it exists.

```sh
node packages/inspired-lint/src/cli.ts rules --config CONFIG [--query TEXT]
node packages/inspired-lint/src/cli.ts rule --config CONFIG --candidate FILE [--out FILE] [--replay] [--cache FILE] [--provider P] [--model M]
node packages/inspired-lint/src/cli.ts decide --config CONFIG --question TEXT --file PATH[:FROM-TO] [--replay] [--cache FILE] [--provider P] [--model M]
node packages/inspired-lint/src/cli.ts calibrate --config CONFIG --candidate FILE --labels FILE [--labels FILE ...] [--out FILE] [--replay] [--cache FILE] [--provider P] [--model M]
node packages/inspired-lint/src/cli.ts catalog --engine FILE --trusted-config FILE --schema FILE --output FILE
node packages/inspired-lint/src/cli.ts references --config CONFIG
```

`rules` searches catalog names and summaries, returns configured rules first, and limits results to 20. An exact full name also returns its option schema. `fresh: false` means the catalog's source hashes changed. Rebuild the catalog before relying on it to prevent duplicate proposals.

`catalog` combines Oxlint's native metadata with configured JS plugin rules from an explicitly trusted lint config. The trusted config and its imported presets execute in an isolated child process. This process is not a sandbox. Never point it at a reference repository's config. For this workspace:

```sh
node packages/inspired-lint/src/cli.ts catalog --engine node_modules/oxlint/bin/oxlint --trusted-config oxlint.config.ts --schema node_modules/oxlint/configuration_schema.json --output .agents/lint-rule-finder/rule-catalog.json
```

`rule` checks fixtures, then measures each repository. Its summary prints contrast, eligible and measured files, affected-file rates, finding counts, durations, the first 30 codebase findings with excerpts, and up to five reference examples per repository. `--out` writes the full measurement and every codebase finding. A parse error, rule exception, malformed diagnostics, or exceeded limit invalidates the measurement. Invalid measurements and failed fixtures exit with status 1.

`decide` asks one yes/no question about a file span. Without a range it uses the whole file. Its JSON includes `probability`, `answeredBy`, and whether the answer came from the cache.

`calibrate` scores a semantic candidate against one or more [label files](#labels). It reports precision, recall, and flagged labels at each cutoff. `selectorMissed` counts labels that the selector never reached.

`--provider` and `--model` override config for one command. `--cache` changes the answer cache path. `--replay` reads cached answers without making model calls. Missing replay answers do not become negative answers.

## Candidate format

Every candidate has `id`, `kind`, `options`, `rationale`, `knownLimitations`, and `fixtures`. Options are an array without severity. Fixtures contain positive, negative, and fixed TypeScript snippets. The positive must be flagged. The negative and fixed snippets must not be flagged.

### Built-in candidate

Built-in candidates support measurement and setup checks. Discovery proposes new plugin rules and uses catalog searches to avoid duplicates.

```json
{
  "id": "avoid-async-executors",
  "kind": "builtin",
  "rule": "no-async-promise-executor",
  "options": [],
  "rationale": "An async executor can reject without rejecting its outer Promise.",
  "knownLimitations": [],
  "fixtures": {
    "positive": "new Promise(async resolve => { resolve(1); });",
    "negative": "new Promise(resolve => { resolve(1); });",
    "fixed": "Promise.resolve(1);"
  }
}
```

### Plugin candidate

The candidate's `id` is its rule name. Its `code` is an ES module whose default export is an ESLint-style rule:

```json
{
  "id": "avoid-debugger",
  "kind": "plugin",
  "code": "export default { meta: { type: 'problem', docs: { description: 'No debugger statements.' }, schema: [] }, create(context) { return { DebuggerStatement(node) { context.report({ node, message: 'Remove this debugger statement.' }) } } } }",
  "options": [],
  "rationale": "Debugger statements interrupt execution when a debugger is attached.",
  "knownLimitations": [],
  "fixtures": {
    "positive": "debugger;",
    "negative": "const value = 1;",
    "fixed": "const value = 1;"
  }
}
```

This example demonstrates the format, not a discovery proposal. Write candidates that import only Node built-ins. Do not import code from the compared repositories. It runs in Oxlint's JS plugin host. Candidate code is executable code and must be trusted.

Measurements run one rule at a time through Oxlint 1.87.0, without type-aware analysis. Inline source suppressions keep their normal meaning. Project ignores, overrides, and lint baselines do not apply. Plugin load errors, thrown rules, and invalid options invalidate the measurement. `detail` contains the engine error.

### Semantic candidate

A semantic candidate has a deterministic selector and a yes/no question. Every selector report is a candidate. A probability at or above `cutoff` becomes a finding.

```json
{
  "id": "unnecessary-debugger",
  "kind": "semantic",
  "selector": "export default { meta: { schema: [] }, create(context) { return { DebuggerStatement(node) { context.report({ node, message: 'candidate' }) } } } }",
  "question": "Does the marked debugger statement interrupt normal execution?",
  "cutoff": 0.8,
  "context": { "before": 0, "after": 0 },
  "options": [],
  "rationale": "This example demonstrates the semantic candidate shape.",
  "knownLimitations": ["A deterministic rule is sufficient for this example."],
  "fixtures": {
    "positive": "debugger;",
    "negative": "const value = 1;",
    "fixed": "const value = 1;"
  }
}
```

The question must make "yes" mean "report this". `cutoff` is strictly between 0 and 1. `context.before` and `context.after` default to 0 and each accept 0 through 200 lines. The model sees the reported node marked by `/*>>*/` and `/*<<*/`. A selector report message of `context:FROM-TO` supplies a larger line range, often an enclosing function obtained from `context.sourceCode.getAncestors(node)`. Context line counts extend that range.

Semantic fixtures apply the same cutoff as findings. A measurement adds decision counts, cost estimates, answering models, candidate counts, and a curve at cutoffs 0, 0.5, 0.6, 0.7, 0.8, 0.9, and 0.95. Cutoff 0 reports the selector alone. `bestCutoff` maximizes the rate difference while every reference stays at or below 2%. If the selector already gives the contrast, use a deterministic plugin rule.

## Providers and data egress

Decisions use TanStack AI's `decide()`. Credentials come from provider environment variables or the logged-in `cf` CLI, never config JSON.

| Provider | Adapter | Example model | Credentials and destination |
| --- | --- | --- | --- |
| `cf-cli` | Logged-in `cf` CLI, `cf ai run` | `@cf/cloudflare/clef-flash`, `@cf/cloudflare/clef` | `cf auth login`. Requests use the user's own Cloudflare account. The runtime does not read its token. |
| `cloudflare` | `@tanstack/ai-cloudflare` | `@cf/cloudflare/clef-flash`, `@cf/cloudflare/clef`, `typesafe/jev` | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`. Requests use the configured Cloudflare account. |
| `typesafe` | `@tanstack/ai-typesafe` | `jev-latest` | `TYPESAFE_API_KEY`. Snippets go to TypeSafe. |
| `openai` | `@tanstack/ai-openai` | `gpt-6-luna` | `OPENAI_API_KEY`. Snippets go to OpenAI. |
| `openrouter` | `@tanstack/ai-openrouter` | `~typesafe/jev-latest` | `OPENROUTER_API_KEY`. Snippets go through OpenRouter to the selected model host. |
| `ollaya` | `@tanstack/ai-ollaya` | `laya:latest` | No key. A local server keeps requests local. |

Model requests contain the question and source snippets. Choosing another hosted provider sends those snippets to that provider. This repository chooses `cf-cli` with Clef-flash in the owner's own account. Secret-looking snippets are skipped before any provider call. Secret filtering is heuristic and does not make arbitrary source safe to disclose.

The owner's Clef pilot estimated about $0.03 for a full semantic measurement of roughly 250 candidates. This is pilot evidence, not a price guarantee. Estimates use snippet length divided by four for input tokens and the configured input price. Actual usage depends on context, provider, and current pricing.

## Cache

The default cache is `decisions.cache.json` next to the config. `--cache FILE` selects another path. Version 1 has this shape:

```json
{
  "version": 1,
  "entries": {
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef": {
      "probability": 0.85,
      "model": "clef-flash"
    }
  }
}
```

Each key is the SHA-256 hash of the JSON array `[provider, configuredModel, question, snippet]`. Each answer records its probability and the answering model version. The cache contains hashes and answers, not snippets. Changing the cutoff reuses answers. Changing the provider, configured model, question, or snippet creates a different key. Identical pending inputs share one decision. Provider failures fail the measurement.

## Labels

Review labels refer to codebase-relative paths and positive line numbers:

```json
{
  "rule": "optional-read-guard",
  "labels": [
    { "path": "src/example.ts", "line": 12, "label": "real" },
    { "path": "src/other.ts", "line": 20, "label": "acceptable", "note": "The existing form preserves an invariant." },
    { "path": "src/third.ts", "line": 8, "label": "false-positive" }
  ]
}
```

The rule ID must match the candidate. A label matches when its line falls within a selector node. Precision is the fraction of flagged labeled findings marked `real`. Recall is the fraction of labeled real findings flagged. Labels outside all selector nodes count toward `selectorMissed`.
