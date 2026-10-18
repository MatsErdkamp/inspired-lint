import assert from "node:assert/strict";
import { access, appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildCatalog, catalogFromOutputs, verifyCatalog } from "../src/catalog.ts";
import { RuleCatalogSchema, hash } from "../src/model.ts";

test("catalog preserves effective scopes, disabled configurations and installed rule option schemas", () => {
  const catalog = catalogFromOutputs({ version: "fixture", sources: [], configuration: {
    rules: { "eslint/no-debugger": "deny", "typescript/assert": ["deny", { mode: "never" }] },
    overrides: [{ files: ["**/generated.ts"], rules: { "no-debugger": "allow", "custom/boundary": "deny" } }],
  }, registry: [{ scope: "eslint", value: "no-debugger", category: "correctness", type_aware: false, fix: "none", docs_url: "https://example.test/debugger" },
    { scope: "typescript", value: "assert", category: "style", type_aware: true, fix: "pending", docs_url: "https://example.test/assert" }],
    schema: { definitions: { DummyRuleMap: { properties: { "typescript/assert": { $ref: "#/definitions/Options" } } },
      Options: { type: "object", properties: { mode: { enum: ["never", "always"] } } } } } });
  assert.equal(catalog.rules.length, 3);
  const debuggerRule = catalog.rules.find((rule) => rule.name === "no-debugger"); assert.ok(debuggerRule);
  assert.deepEqual(debuggerRule.configuration, { base: "deny", overrides: [{ files: ["**/generated.ts"], value: "allow" }] });
  const assertion = catalog.rules.find((rule) => rule.name === "typescript/assert"); assert.ok(assertion);
  assert.match(assertion.summary, /requires type information/u);
  assert.deepEqual(assertion.optionsSchema, { type: "object", properties: { mode: { enum: ["never", "always"] } } });
  assert.match(catalog.rules.find((rule) => rule.name === "custom/boundary")?.summary ?? "", /project\/plugin/u);
});

test("nested option references resolve independently of structural depth and cycles terminate", () => {
  const catalog = catalogFromOutputs({ version: "fixture", sources: [], configuration: {}, registry: [{ scope: "typescript", value: "assert", category: "style", type_aware: false, fix: "none", docs_url: "https://example.test/assert" }],
    schema: { definitions: { DummyRuleMap: { properties: { "typescript/assert": { anyOf: [{ type: "array", items: [{ type: "string" }, { $ref: "#/definitions/Options" }] }] } } },
      Options: { type: "object", properties: { objectLiteralTypeAssertions: { allOf: [{ $ref: "#/definitions/Mode" }] }, recursive: { $ref: "#/definitions/Options" } } },
      Mode: { enum: ["always", "never", "allow-as-parameter"], markdownDescription: "duplicate text" } } } });
  const options = JSON.stringify(catalog.rules[0]?.optionsSchema);
  assert.match(options, /allow-as-parameter/u);
  assert.ok(!options.includes("$ref"));
  assert.ok(!options.includes("markdownDescription"));
  assert.match(options, /Recursive or unavailable/u);
  assert.match(catalog.rules[0]?.summary ?? "", /objectLiteralTypeAssertions/u);
});

const engine = fileURLToPath(new URL("../node_modules/oxlint/bin/oxlint", import.meta.url));
const schema = fileURLToPath(new URL("../node_modules/oxlint/configuration_schema.json", import.meta.url));

async function installedFixture() {
  const directory = await mkdtemp(join(tmpdir(), "lint-catalog-"));
  const config = join(directory, "oxlint.config.mjs"), preset = join(directory, "preset.mjs"), marker = join(directory, "trusted-config-runs.txt");
  await writeFile(config, `import { appendFileSync } from "node:fs"; import preset from "./preset.mjs"; appendFileSync(${JSON.stringify(marker)}, "run\\n"); export default { extends: [preset] };`);
  await writeFile(preset, `export default ${JSON.stringify({ rules: { "no-debugger": "warn" } })};`);
  const output = join(directory, "catalog.json");
  const catalog = await buildCatalog({ engine, config, schema, output, cwd: directory });
  return { directory, config, preset, marker, output, catalog };
}

test("installed Oxlint verifies a saved catalog and detects imported preset changes", async () => {
  const fixture = await installedFixture();
  try {
    const saved = RuleCatalogSchema.parse(JSON.parse(await readFile(fixture.output, "utf8")));
    assert.deepEqual(await verifyCatalog(saved), { verified: true });
    assert.equal(saved.rules.find((rule) => rule.name === "no-debugger")?.configured, true);
    await writeFile(fixture.preset, `export default ${JSON.stringify({ rules: { "no-debugger": "error" } })};`);
    await assert.rejects(verifyCatalog(saved), /catalog is stale/u);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("a changed trusted source is rejected before its configuration executes", async () => {
  const fixture = await installedFixture();
  try {
    const previousRuns = await readFile(fixture.marker, "utf8");
    await appendFile(fixture.config, "\n// changed trusted configuration\n");
    await assert.rejects(verifyCatalog(fixture.catalog), /catalog is stale/u);
    assert.equal(await readFile(fixture.marker, "utf8"), previousRuns);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("dependency declarations and newly added lockfiles make a catalog stale", async () => {
  const fixture = await installedFixture();
  try {
    await writeFile(join(fixture.directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await assert.rejects(verifyCatalog(fixture.catalog), /catalog is stale/u);
    const catalog = await buildCatalog({ engine, config: fixture.config, schema, output: fixture.output, cwd: fixture.directory });
    const previousRuns = await readFile(fixture.marker, "utf8");
    await appendFile(join(fixture.directory, "pnpm-lock.yaml"), "settings: {}\n");
    await assert.rejects(verifyCatalog(catalog), /catalog is stale/u);
    assert.equal(await readFile(fixture.marker, "utf8"), previousRuns);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("metadata-only catalogs are explicitly unverified and execute no source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lint-catalog-metadata-"));
  try {
    const marker = join(directory, "must-not-exist"), source = join(directory, "untrusted-reference.mjs");
    const code = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed");`;
    await writeFile(source, code);
    const catalog = catalogFromOutputs({ version: "metadata", configuration: {}, registry: [], schema: { definitions: { DummyRuleMap: { properties: {} } } }, sources: [{ path: source, sha256: hash(code) }] });
    assert.deepEqual(await verifyCatalog(catalog), { verified: false, reason: "Metadata-only catalog has no trusted provenance; freshness is unverified." });
    await assert.rejects(access(marker), /ENOENT/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("catalog includes top-level and overridden configured JS-plugin rules omitted by print-config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lint-catalog-plugin-"))
  try {
    const plugin = join(directory, "plugin.mjs")
    const config = join(directory, "oxlint.config.mjs")
    await writeFile(plugin, 'export default { rules: { boundary: { meta: { schema: [] }, create() { return {} } } } }')
    await writeFile(config, `export default { jsPlugins: [{ name: "custom", specifier: ${JSON.stringify(plugin)} }], rules: { "custom/boundary": "error" }, overrides: [{ files: ["**/generated.ts"], rules: { "custom/boundary": "off" } }] }`)
    const catalog = await buildCatalog({ engine, config, schema, output: join(directory, "catalog.json"), cwd: directory })
    const rule = catalog.rules.find((entry) => entry.name === "custom/boundary")
    assert.equal(rule?.configured, true)
    assert.deepEqual(rule?.configuration, { base: "error", overrides: [{ files: ["**/generated.ts"], value: "off" }] })
    assert.deepEqual(await verifyCatalog(catalog), { verified: true })
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test("a repeated shared preset reapplies built-in and JS-plugin rules in the same order as Oxlint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lint-catalog-precedence-"))
  try {
    const config = join(directory, "oxlint.config.mjs")
    const plugin = join(directory, "plugin.mjs")
    await writeFile(plugin, 'export default { rules: { boundary: { meta: { schema: [] }, create() { return {} } } } }')
    await writeFile(config, `const shared = { rules: { "no-debugger": "warn", "custom/boundary": "warn" } }; export default { jsPlugins: [{ name: "custom", specifier: ${JSON.stringify(plugin)} }], extends: [{ extends: [shared], rules: { "no-debugger": "error", "custom/boundary": "error" } }, shared] }`)
    const catalog = await buildCatalog({ engine, config, schema, output: join(directory, "catalog.json"), cwd: directory })
    assert.deepEqual(catalog.rules.find((rule) => rule.name === "no-debugger")?.configuration, { base: "warn", overrides: [] })
    assert.deepEqual(catalog.rules.find((rule) => rule.name === "custom/boundary")?.configuration, { base: "warn", overrides: [] })
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})
