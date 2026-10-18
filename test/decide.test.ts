import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AnyEvaluateAdapter } from "@tanstack/ai";
import { chmod, writeFile } from "node:fs/promises";
import { cfCliDecider, decideAll, openCache } from "../src/decide.ts";
import { DecisionConfigSchema } from "../src/model.ts";

/** A decision model that answers 0.9 when a snippet contains BAD and 0.1 otherwise, through TanStack AI's real decide(). */
function fakeAdapter(calls: { snippets: number }[] = []): AnyEvaluateAdapter {
  return {
    kind: "evaluate", name: "fake", model: "fake-1", "~types": { providerOptions: {} },
    evaluate: async ({ state, questions }) => {
      const snippets = (state as { snippets: Record<string, string> }).snippets;
      calls.push({ snippets: Object.keys(snippets).length });
      return {
        model: "fake-1.0.3",
        answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: "noul" as const, noul: snippets[id]?.includes("BAD") ? 0.9 : 0.1 }])),
        usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 },
      };
    },
  } as AnyEvaluateAdapter;
}
const config = DecisionConfigSchema.parse({ provider: "cloudflare", model: "@cf/cloudflare/clef-flash", snippetsPerRequest: 2, concurrency: 2 });

test("batches snippets, records the answering model and caches answers by content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lrf-decide-"));
  try {
    const path = join(directory, "decisions.json"), calls: { snippets: number }[] = [];
    const items = [{ key: "a", snippet: "BAD one" }, { key: "b", snippet: "fine" }, { key: "c", snippet: "BAD two" }, { key: "d", snippet: "BAD one" }];
    const first = await decideAll({ config, cache: await openCache(path), instructions: "Is it bad?", items, adapter: fakeAdapter(calls) });
    assert.deepEqual(Object.fromEntries(first.probabilities), { a: 0.9, b: 0.1, c: 0.9, d: 0.9 });
    assert.equal(first.asked, 3, "identical snippets are asked once");
    assert.deepEqual(calls.map((call) => call.snippets).sort(), [1, 2]);
    assert.deepEqual(first.models, ["fake-1.0.3"]);
    const stored = JSON.parse(await readFile(path, "utf8"));
    assert.equal(Object.keys(stored.entries).length, 3);
    const second = await decideAll({ config, cache: await openCache(path), instructions: "Is it bad?", items, adapter: fakeAdapter(calls) });
    assert.equal(second.asked, 0);
    assert.equal(second.cached, 4);
    const changed = await decideAll({ config, cache: await openCache(path), instructions: "Is it worse?", items: items.slice(0, 1), adapter: fakeAdapter(calls) });
    assert.equal(changed.asked, 1, "a different question is a different decision");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("replay never calls the provider, secrets are never sent, and the budget stops a large run", async () => {
  const calls: { snippets: number }[] = [];
  const replay = await decideAll({ config, cache: await openCache(null), instructions: "Is it bad?", mode: "replay",
    items: [{ key: "a", snippet: "BAD" }], adapter: fakeAdapter(calls) });
  assert.equal(replay.skipped.replayMiss, 1);
  const secret = await decideAll({ config, cache: await openCache(null), instructions: "Is it bad?",
    items: [{ key: "a", snippet: "const key = 'AKIAABCDEFGHIJKLMNOP'" }], adapter: fakeAdapter(calls) });
  assert.equal(secret.skipped.secret, 1);
  assert.equal(calls.length, 0);
  await assert.rejects(decideAll({ config: { ...config, maxDecisions: 1 }, cache: await openCache(null), instructions: "Is it bad?",
    items: [{ key: "a", snippet: "one" }, { key: "b", snippet: "two" }], adapter: fakeAdapter(calls) }), /budget exceeded/);
});

test("a provider failure fails the whole decision run instead of leaving gaps", async () => {
  const failing = { ...fakeAdapter(), evaluate: async () => { throw new Error("401 Unauthorized"); } } as AnyEvaluateAdapter;
  await assert.rejects(decideAll({ config, cache: await openCache(null), instructions: "Is it bad?", items: [{ key: "a", snippet: "x" }], adapter: failing }), /401 Unauthorized/);
});

test("the cf-cli provider sends Clef's short model name and the questions through `cf ai run`", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lrf-cf-bin-"));
  const path = process.env.PATH;
  try {
    // A stand-in `cf` that records its arguments and body and answers 0.8 for every question.
    await writeFile(join(directory, "cf"), `#!/usr/bin/env node
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf("--body") + 1].slice(1), "utf8"));
fs.writeFileSync(${JSON.stringify(join(directory, "seen.json"))}, JSON.stringify({ argv: process.argv.slice(2, 4), body }));
process.stdout.write(JSON.stringify({ model: body.model, answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "noul", noul: 0.8 }])), usage: { input_tokens: 12, output_tokens: 0 } }));
`);
    await chmod(join(directory, "cf"), 0o755);
    process.env.PATH = `${directory}:${path}`;
    const outcome = await decideAll({ config: { ...config, provider: "cf-cli" }, cache: await openCache(null), instructions: "Is it bad?",
      items: [{ key: "a", snippet: "x" }], adapter: cfCliDecider("@cf/cloudflare/clef-flash") });
    assert.equal(outcome.probabilities.get("a"), 0.8);
    assert.deepEqual(outcome.models, ["clef-flash"]);
    const seen = JSON.parse(await readFile(join(directory, "seen.json"), "utf8"));
    assert.deepEqual(seen.argv, ["ai", "run"]);
    assert.equal(seen.body.model, "clef-flash");
    assert.deepEqual(Object.keys(seen.body.questions), ["s0"]);
    assert.equal(seen.body.state.snippets.s0, "x");
  } finally {
    process.env.PATH = path;
    await rm(directory, { recursive: true, force: true });
  }
});


test("cf-cli failures preserve stderr, enforce cancellation and clean up request files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lrf-cf-failure-"));
  const originalPath = process.env.PATH;
  const requestPath = join(directory, "request-path.txt");
  try {
    await writeFile(join(directory, "cf"), `#!/usr/bin/env node
const fs = require("node:fs");
const body = process.argv[process.argv.indexOf("--body") + 1].slice(1);
fs.writeFileSync(${JSON.stringify(requestPath)}, body);
if (process.argv[4] === "abort") { setTimeout(() => {}, 60000); }
else if (process.argv[4] === "overflow") { process.stdout.write("x".repeat(20 * 1024 * 1024)); }
else { process.stderr.write("provider unavailable"); process.exitCode = 3; }
`);
    await chmod(join(directory, "cf"), 0o755);
    process.env.PATH = `${directory}:${originalPath}`;
    const invoke = (model: string) => decideAll({ config: { ...config, provider: "cf-cli", model, timeoutMs: 1000 }, cache: { path: null, entries: new Map() }, instructions: "Is it bad?", items: [{ key: "a", snippet: "x" }] });
    await assert.rejects(invoke("failed"), /cf ai run failed: provider unavailable/);
    await assert.rejects(readFile(await readFile(requestPath, "utf8")), { code: "ENOENT" });
    await assert.rejects(invoke("overflow"), /cf ai run failed:/);
    await assert.rejects(readFile(await readFile(requestPath, "utf8")), { code: "ENOENT" });
    await assert.rejects(invoke("abort"), /cf ai run failed:/);
    await assert.rejects(readFile(await readFile(requestPath, "utf8")), { code: "ENOENT" });
  } finally {
    if (originalPath === undefined) { delete process.env.PATH; } else { process.env.PATH = originalPath; }
    await rm(directory, { recursive: true, force: true });
  }
});
