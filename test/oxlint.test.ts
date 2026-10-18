import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { evaluateRule } from "../src/oxlint.ts";

test("built-in rules, including plugin rules, run positive, negative and fixed snippets through the real engine", async () => {
  const cases: { rule: string; options: Parameters<typeof evaluateRule>[0]["options"]; positive: string; fixed: string }[] = [
    { rule: "no-async-promise-executor", options: [], positive: "new Promise(async resolve => resolve(1));", fixed: "new Promise(resolve => resolve(1));" },
    { rule: "no-nested-ternary", options: [], positive: "const n = a ? b ? 1 : 2 : 3;", fixed: "const n = a ? 1 : 2;" },
    { rule: "max-depth", options: [1], positive: "if (a) { if (b) { f(); } }", fixed: "if (a && b) { f(); }" },
    { rule: "max-params", options: [{ max: 1 }], positive: "function save(a: string, b: string) {}", fixed: "function save(options: {a:string,b:string}) {}" },
    { rule: "unicorn/no-array-for-each", options: [], positive: "items.forEach((item) => use(item));", fixed: "for (const item of items) use(item);" },
    { rule: "typescript/consistent-type-assertions", options: [{ objectLiteralTypeAssertions: "never" }], positive: "const value = {} as Shape;", fixed: "const value: Shape = {};" },
  ];
  for (const fixture of cases) {
    const result = await evaluateRule({ rule: fixture.rule, options: fixture.options, files: [
      { id: "positive.ts", source: fixture.positive }, { id: "negative.ts", source: "const fine = 1;" }, { id: "fixed.ts", source: fixture.fixed },
      { id: "jsx.tsx", source: "const View = () => <main />;" },
    ] });
    assert.equal(result.status, "valid", fixture.rule);
    if (result.status !== "valid") continue;
    assert.deepEqual(result.affected, ["positive.ts"], fixture.rule);
    assert.ok(result.diagnostics.length > 0 && result.diagnostics.every((diagnostic) => diagnostic.id === "positive.ts" && diagnostic.line > 0 && diagnostic.column > 0));
  }
});

test("source imports, hostile surrounding configs/plugins and runtime preload overrides cannot execute", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lrf-native-boundary-"));
  const originalCwd = process.cwd();
  const keys = ["NODE_OPTIONS", "NAPI_RS_NATIVE_LIBRARY_PATH", "TMPDIR"];
  const environment = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    const marker = join(directory, "EXECUTED");
    const hostileCode = `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed"); export default {};`;
    const plugin = join(directory, "plugin.mjs"), preload = join(directory, "preload.mjs");
    await writeFile(plugin, hostileCode);
    await writeFile(preload, hostileCode);
    await writeFile(join(directory, "oxlint.config.ts"), hostileCode);
    await writeFile(join(directory, ".oxlintrc.json"), JSON.stringify({ jsPlugins: [plugin], extends: ["./oxlint.config.ts"] }));
    await writeFile(join(directory, "tsconfig.json"), JSON.stringify({ extends: "./MUST_NOT_BE_READ.json", compilerOptions: { plugins: [{ name: plugin }] } }));
    await writeFile(join(directory, ".eslintignore"), "*\n");
    const binding = join(directory, "binding.cjs");
    await writeFile(binding, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "binding"); module.exports={};`);
    process.env.NODE_OPTIONS = `--import=${pathToFileURL(preload).href}`;
    process.env.NAPI_RS_NATIVE_LIBRARY_PATH = binding;
    process.env.TMPDIR = directory;
    process.chdir(directory);
    const result = await evaluateRule({ rule: "no-async-promise-executor", options: [], files: [{
      id: join(directory, "../unselected.ts"), source: `import ${JSON.stringify(pathToFileURL(plugin).href)};\nnew Promise(async resolve => resolve(1));`,
    }] });
    assert.equal(result.status, "valid");
    if (result.status === "valid") assert.deepEqual(result.diagnostics.map(({ id, line, column }) => ({ id, line, column })), [{ id: join(directory, "../unselected.ts"), line: 2, column: 13 }]);
    await assert.rejects(access(marker), { code: "ENOENT" });
    assert.equal(await readFile(join(directory, "tsconfig.json"), "utf8"), JSON.stringify({ extends: "./MUST_NOT_BE_READ.json", compilerOptions: { plugins: [{ name: plugin }] } }));
  } finally {
    process.chdir(originalCwd);
    for (const [key, value] of environment) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(directory, { recursive: true, force: true });
  }
});

test("inline suppressions keep their production meaning", async () => {
  const result = await evaluateRule({ rule: "no-async-promise-executor", options: [], files: [
    { id: "eslint.ts", source: "// eslint-disable-next-line no-async-promise-executor\nnew Promise(async resolve => resolve(1));" },
    { id: "oxlint.ts", source: "// oxlint-disable-next-line no-async-promise-executor\nnew Promise(async resolve => resolve(1));" },
    { id: "reported.ts", source: "new Promise(async resolve => resolve(1));" },
  ] });
  assert.equal(result.status, "valid");
  if (result.status === "valid") assert.deepEqual(result.affected, ["reported.ts"]);
});

test("parse errors, invalid options, timeouts and diagnostic overflow invalidate the measurement", async () => {
  // Oxlint itself rejects unknown rules and malformed options; either way the measurement is invalid, not empty.
  for (const [rule, options] of [["max-params", [{ max: "many" }]], ["no-such-rule", []], ["unicorn/no-such-rule", []]] as const) {
    const result = await evaluateRule({ rule, options, files: [{ id: "a.ts", source: "function f(a, b) {}" }] });
    assert.equal(result.status, "invalid", rule);
  }
  assert.deepEqual(await evaluateRule({ rule: "../plugin", options: [], files: [{ id: "a.ts", source: "" }] }), { status: "invalid", errorCode: "invalid-input" });
  const parse = await evaluateRule({ rule: "max-params", options: [], files: [{ id: "a.ts", source: "function { /* SOURCE_CANARY */" }] });
  assert.equal(parse.status === "invalid" && parse.errorCode, "parse-error");
  const source = "new Promise(async resolve => resolve(1));";
  assert.deepEqual(await evaluateRule({ rule: "no-async-promise-executor", options: [], files: [{ id: "a.ts", source: source + source }], limits: { maxDiagnostics: 1 } }), { status: "invalid", errorCode: "resource-limit" });
  assert.deepEqual(await evaluateRule({ rule: "max-params", options: [], files: [{ id: "a.ts", source }], limits: { totalMs: 1 } }), { status: "invalid", errorCode: "resource-limit" });
});

test("all selected files survive native batching and Unicode columns normalize to UTF-16", async () => {
  const files = Array.from({ length: 151 }, (_, index) => ({ id: `source-${index}.ts`, source: "const fine = 1;" }));
  files.push({ id: "unicode.ts", source: "const 汉字 = 1; new Promise(async resolve => resolve(1));" });
  const result = await evaluateRule({ rule: "no-async-promise-executor", options: [], files });
  assert.equal(result.status, "valid");
  if (result.status === "valid") assert.deepEqual(result.diagnostics.map(({ id, line, column }) => ({ id, line, column })), [{ id: "unicode.ts", line: 1, column: 27 }]);
});

const debuggerRule = `export default {
  meta: { type: "problem", schema: [] },
  create(context) {
    return { DebuggerStatement(node) { context.report({ node, message: "Remove debugger." }); } };
  },
};`;

test("a candidate plugin rule runs through Oxlint's JS plugin loader", async () => {
  const result = await evaluateRule({ rule: "no-debugger-statement", plugin: debuggerRule, options: [], files: [
    { id: "positive.ts", source: "function f() {\n  debugger;\n}" }, { id: "negative.ts", source: "function f() {}" },
    { id: "view.tsx", source: "const View = () => <main />;" },
  ] });
  assert.deepEqual(result, { status: "valid", affected: ["positive.ts"],
    diagnostics: [{ id: "positive.ts", line: 2, column: 3, endLine: 2, endColumn: 12, message: "Remove debugger." }] });
});

test("a plugin rule that fails to load or throws is invalid and carries Oxlint's message", async () => {
  const files = [{ id: "a.ts", source: "debugger;" }];
  for (const plugin of ["export default {", "export default { create() { throw new Error('RULE_EXPLODED'); } };"]) {
    const result = await evaluateRule({ rule: "broken", plugin, options: [], files });
    assert.equal(result.status, "invalid", plugin);
    if (result.status === "invalid") assert.ok(result.detail && result.detail.length > 0, plugin);
  }
  assert.deepEqual(await evaluateRule({ rule: "plugin/nested", plugin: debuggerRule, options: [], files }), { status: "invalid", errorCode: "invalid-input" });
});


test("an Oxlint process killed at the output buffer limit invalidates the measurement as a resource limit", async () => {
  const result = await evaluateRule({
    rule: "large-output",
    options: [],
    files: [{ id: "source.ts", source: "const value = 1" }],
    limits: { totalMs: 10000 },
    plugin: `export default { meta: { messages: { finding: "x".repeat(2048) } }, create(context) { return { Program(node) { for (let index = 0; index < 6000; index += 1) { context.report({ node, messageId: "finding" }) } } } } }`,
  });
  assert.deepEqual(result, { status: "invalid", errorCode: "resource-limit" });
});
