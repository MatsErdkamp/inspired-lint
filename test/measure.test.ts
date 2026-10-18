import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { AnyEvaluateAdapter } from "@tanstack/ai";
import { openCache } from "../src/decide.ts";
import { calibrate, measure } from "../src/measure.ts";
import { ConfigSchema } from "../src/model.ts";
import type { Candidate, Config } from "../src/model.ts";

const limits = { totalMs: 60_000, maxDiagnostics: 1000 };
function candidate(token: string): Extract<Candidate, { kind: "plugin" }> {
  return {
    id: "find-token", kind: "plugin", options: [],
    code: `export default {
      meta: { schema: [] },
      create(context) {
        return { Program() {
          context.sourceCode.getAllComments().filter((comment) => comment.value.includes(${JSON.stringify(token)}))
            .forEach((comment) => context.report({ loc: comment.loc, message: "token" }));
        } };
      },
    };`,
    rationale: "Synthetic", knownLimitations: [],
    fixtures: { positive: `const a = 1; // ${token}`, negative: "const a = 1;", fixed: "const b = 1;" },
  };
}
async function corpus(action: (config: Config) => Promise<void>, maxFilesPerRepository?: number): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "lrf-measure-"));
  try {
    const sources: Record<string, Record<string, string>> = {
      codebase: { "packages/a/src/one.ts": "const x = 1; // TOKEN\nconst y = 2; // TOKEN", "packages/a/src/two.ts": "const z = 3;",
        "packages/a/src/two.test.ts": "// TOKEN", "packages/a/src/generated/three.ts": "// TOKEN" },
      reference: { "packages/b/src/one.ts": "const x = 1;", "packages/b/src/two.ts": "// TOKEN", "packages/b/src/three.ts": "const y = 1;", "packages/b/src/four.ts": "const z = 1;" },
    };
    for (const [label, files] of Object.entries(sources)) {
      for (const [path, source] of Object.entries(files)) {
        await mkdir(dirname(join(root, label, path)), { recursive: true });
        await writeFile(join(root, label, path), source);
      }
    }
    await action(ConfigSchema.parse({ version: 3, repositories: Object.keys(sources).map((label) => ({ label, root: join(root, label) })),
      lanes: [{ id: "lane", angle: "test" }], limits, ...(maxFilesPerRepository ? { maxFilesPerRepository } : {}) }));
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("measures current production source per repository, with every codebase finding and reference examples", async () => {
  await corpus(async (config) => {
    const result = await measure(config, candidate("TOKEN"));
    assert.equal(result.status, "valid", result.errorCode ?? "");
    assert.deepEqual(result.fixtures, { valid: true, errorCode: null, detail: null });
    assert.deepEqual(result.repositories.map(({ label, files, affected, findings }) => [label, files, affected, findings]),
      [["codebase", 2, 1, 2], ["reference", 4, 1, 1]]);
    assert.deepEqual(result.codebaseFindings.map(({ path, line }) => [path, line]), [["packages/a/src/one.ts", 1], ["packages/a/src/one.ts", 2]]);
    assert.deepEqual(result.referenceExamples.reference?.map((item) => item.path), ["packages/b/src/two.ts"]);
    assert.deepEqual(result.contrast, { codebaseRate: 0.5, maxReferenceRate: 0.25, difference: 0.25, ratios: { reference: 2 } });
  });
});

test("reports fixture mismatches and rule failures instead of counts", async () => {
  await corpus(async (config) => {
    const loose = { ...candidate("TOKEN"), fixtures: { positive: "const a = 1;", negative: "const a = 1;", fixed: "const b = 1;" } };
    assert.equal((await measure(config, loose)).fixtures.errorCode, "fixture-expectation-mismatch");
    const broken = { ...candidate("TOKEN"), code: "export default { create() { throw new Error('boom'); } };" };
    const result = await measure(config, broken);
    assert.equal(result.status, "invalid");
    assert.match(result.errorCode ?? "", /^codebase: /);
  });
});

test("a file cap keeps the same files across measurements", async () => {
  await corpus(async (config) => {
    const first = await measure(config, candidate("TOKEN"));
    const second = await measure(config, candidate("other"));
    assert.deepEqual(first.repositories.map((item) => [item.label, item.eligible, item.files]), [["codebase", 2, 2], ["reference", 4, 3]]);
    assert.deepEqual(second.repositories.map((item) => item.files), first.repositories.map((item) => item.files));
  }, 3);
});

/** Flags any snippet whose marked code is on a line declaring `x`. */
const semanticAdapter = {
  kind: "evaluate", name: "fake", model: "fake-1", "~types": { providerOptions: {} },
  evaluate: async ({ state, questions }: { state: unknown; questions: Record<string, unknown> }) => {
    const snippets = (state as { snippets: Record<string, string> }).snippets;
    return { model: "fake-1.0.3", usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 },
      answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: "noul" as const, noul: snippets[id]?.includes("const x") ? 0.9 : 0.1 }])) };
  },
} as unknown as AnyEvaluateAdapter;
const { code: selector, kind: _kind, ...shared } = candidate("TOKEN");
const semantic = {
  ...shared, kind: "semantic" as const, id: "token-on-x", selector, question: "Is the marked comment on a line that declares x?", cutoff: 0.8, context: { before: 0, after: 0 },
  fixtures: { positive: "const x = 1; // TOKEN", negative: "const x = 1;", fixed: "const z = 1; // TOKEN" },
};
const decision = { provider: "cloudflare" as const, model: "@cf/cloudflare/clef-flash", timeoutMs: 1000, concurrency: 1, snippetsPerRequest: 8, maxSnippetChars: 4000, maxDecisions: 100 };

test("a semantic rule keeps only selector candidates the model answers yes to, and reports the cutoff curve", async () => {
  await corpus(async (config) => {
    const result = await measure(config, semantic, { config: decision, adapter: semanticAdapter, cache: await openCache(null) });
    assert.equal(result.status, "valid", result.errorCode ?? "");
    assert.deepEqual(result.fixtures, { valid: true, errorCode: null, detail: null });
    assert.deepEqual(result.repositories.map(({ label, affected, findings }) => [label, affected, findings]), [["codebase", 1, 1], ["reference", 0, 0]]);
    assert.deepEqual(result.codebaseFindings.map(({ path, line, probability }) => [path, line, probability]), [["packages/a/src/one.ts", 1, 0.9]]);
    assert.deepEqual(result.semantic?.candidates, { codebase: 2, reference: 1 });
    assert.deepEqual(result.semantic?.curve[0], { cutoff: 0, rates: { codebase: 0.5, reference: 0.25 }, difference: 0.25 });
    assert.equal(result.semantic?.bestCutoff, 0.5);
    const replay = await measure(config, semantic, { config: decision, adapter: semanticAdapter, cache: await openCache(null), mode: "replay" });
    assert.equal(replay.fixtures.errorCode, "fixture-undecided");
  });
});

test("calibration scores a semantic rule against review labels", async () => {
  await corpus(async (config) => {
    const result = await calibrate(config, semantic, [{ rule: "token", labels: [
      { path: "packages/a/src/one.ts", line: 1, label: "real" }, { path: "packages/a/src/one.ts", line: 2, label: "acceptable" },
      { path: "packages/a/src/missing.ts", line: 1, label: "real" },
    ] }], { config: decision, adapter: semanticAdapter, cache: await openCache(null) });
    assert.equal(result.selectorMissed, 1);
    assert.deepEqual(result.points.find((point) => point.cutoff === 0.8), { cutoff: 0.8, flaggedLabeled: 1, real: 1, acceptable: 0, falsePositive: 0, precision: 1, recall: 0.5, flaggedTotal: 1 });
  });
});
