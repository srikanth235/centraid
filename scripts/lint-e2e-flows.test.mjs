// Fail-path proof for `bun run lint:e2e-flows` (issue #656 Layer 1F).
// A linter that always exits 0 is worse than no linter: these assert that each
// rule REJECTS a synthetic violation and ACCEPTS the compliant twin.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { discoverFiles, lintFlowSource } from "./lint-e2e-flows.mjs";

const rules = (src) =>
  lintFlowSource(src)
    .findings.map((f) => f.rule)
    .sort();

test("route-name rejects an assertion keyed on a bare tab label", () => {
  assert.deepEqual(rules('- assertVisible: "Docs"\n'), ["route-name"]);
});

test("route-name rejects a tab label carrying a Maestro `.*` suffix", () => {
  assert.deepEqual(rules('- assertVisible: "Settings.*"\n'), ["route-name"]);
});

test("route-name rejects assertNotVisible on a route name that is never text", () => {
  assert.deepEqual(rules('- assertNotVisible: "Apps"\n'), ["route-name"]);
});

test("route-name rejects a block-form assertion on a tab label", () => {
  assert.deepEqual(rules('- extendedWaitUntil:\n    visible: "Photos"\n'), [
    "route-name",
  ]);
});

test("route-name accepts an assertion on a screen-unique string", () => {
  assert.deepEqual(rules('- assertVisible: "Add document or folder"\n'), []);
});

test("route-name is suppressed by an allow marker above the step", () => {
  assert.deepEqual(
    rules(
      '# e2e-lint-allow: route-name — deliberate\n- assertVisible: "Docs"\n'
    ),
    []
  );
});

test("unasserted-input rejects typed text that no later assertion observes", () => {
  assert.deepEqual(rules('- inputText: "hello"\n- tapOn: "Save"\n'), [
    "unasserted-input",
  ]);
});

test("unasserted-input accepts typed text observed by a later assertion", () => {
  assert.deepEqual(
    rules('- inputText: "hello"\n- assertVisible:\n    text: "hello"\n'),
    []
  );
});

test("unasserted-input accepts an assertion whose text contains the typed value", () => {
  assert.deepEqual(
    rules(
      '- inputText: "127.0.0.1:18789"\n- assertVisible: "http://127.0.0.1:18789"\n'
    ),
    []
  );
});

test("unasserted-input rejects an assertion that only lands after a clearState launch", () => {
  assert.deepEqual(
    rules(
      '- inputText: "hello"\n- launchApp:\n    clearState: true\n- assertVisible: "hello"\n'
    ),
    ["unasserted-input"]
  );
});

test("unasserted-input matches interpolations by identity, not by text", () => {
  // oxlint-disable-next-line no-template-curly-in-string
  const same = "- inputText: ${url}\n- assertVisible:\n    text: ${url}\n";
  // oxlint-disable-next-line no-template-curly-in-string
  const other = "- inputText: ${url}\n- assertVisible:\n    text: ${other}\n";
  assert.deepEqual(rules(same), []);
  assert.deepEqual(rules(other), ["unasserted-input"]);
});

test("unasserted-input is suppressed by an allow marker above the step", () => {
  assert.deepEqual(
    rules('# e2e-lint-allow: unasserted-input — throwaway\n- inputText: "x"\n'),
    []
  );
});

test("a finding carries the 1-based line of the offending step", () => {
  const { findings } = lintFlowSource(
    '- tapOn: "Save"\n- assertVisible: "Docs"\n'
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 2);
});

test("the step count backs the silent-no-op guard", () => {
  assert.equal(lintFlowSource("").steps, 0);
  assert.equal(lintFlowSource('- tapOn: "Save"\n').steps, 1);
});

// ---- roster discovery (#842 W0.4). The five `photos-*` journeys and
// `volume-proof` were invisible to this linter for their whole lives because the
// roster was a hand-written FILES array nobody remembered to extend. These prove
// the roster now comes from disk, so being new is not a way to escape a rule.

const repoFile = (rel) => path.resolve(import.meta.dirname, "..", rel);
const FLOW_DIR = "tests/agent-e2e-mobile/flows";
const LIB_DIR = "tests/agent-e2e-mobile/lib";

test("the roster IS the flows directory — a file dropped there is linted", () => {
  // The load-bearing property: nothing between disk and the roster can forget a
  // journey. Recomputed here from `readdirSync`, independently of the linter, so
  // a future roster that starts filtering journeys out fails this.
  const onDisk = readdirSync(repoFile(FLOW_DIR))
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => `${FLOW_DIR}/${name}`)
    .sort();
  assert.deepEqual(
    discoverFiles().filter((f) => f.startsWith(`${FLOW_DIR}/`)),
    onDisk
  );
  assert.ok(onDisk.length >= 16, "the flows directory should not have shrunk");
});

test("SABOTAGE: the linter names no flow file, so none can be forgotten", () => {
  // The old roster was a hand-written FILES array; the five `photos-*` journeys
  // and `volume-proof` were never added to it and went unlinted for their whole
  // lives (#842 W0.4). Re-introducing ANY hardcoded journey path fails here.
  const source = readFileSync(repoFile("scripts/lint-e2e-flows.mjs"), "utf8");
  const hardcoded = [...source.matchAll(/flows\/[\w.-]+\.mjs/gu)].map(
    (m) => m[0]
  );
  assert.deepEqual(hardcoded, []);
});

test("every discovered journey reaches the step grammar", () => {
  // Discovery is worthless if the parser cannot see inside what it finds: a
  // journey that yields zero steps is a stale grammar, and `main()` fails on it.
  for (const rel of discoverFiles()) {
    if (!rel.startsWith(`${FLOW_DIR}/`)) continue;
    const { steps } = lintFlowSource(readFileSync(repoFile(rel), "utf8"));
    assert.ok(steps > 0, `${rel} matched zero Maestro steps`);
  }
});

test("discovery excludes `*.test.mjs` fixtures and non-.mjs neighbours", () => {
  const files = discoverFiles();
  // Real neighbours of both kinds live in these directories today.
  assert.ok(readdirSync(repoFile(LIB_DIR)).includes("frame-report.test.mjs"));
  assert.ok(readdirSync(repoFile(FLOW_DIR)).includes("photos-permissions.md"));
  assert.ok(!files.some((f) => f.endsWith(".test.mjs")));
  assert.ok(files.every((f) => f.endsWith(".mjs")));
});

test("SABOTAGE: a newly discovered flow's vacuous assertion is still caught", () => {
  // The exact shape that escaped the hand-written list: a journey nobody
  // registered, asserting the tab label it just tapped.
  assert.deepEqual(rules('- tapOn: "Photos.*"\n- assertVisible: "Photos"\n'), [
    "route-name",
  ]);
});

test("an allow marker naming a rule that does not exist suppresses nothing", () => {
  // photos-search carried `# e2e-lint-allow: input-observed` — no such rule.
  assert.deepEqual(
    rules(
      '# e2e-lint-allow: input-observed — sounds plausible, is not a rule\n- inputText: "x"\n- tapOn: "Save"\n'
    ),
    ["unasserted-input"]
  );
});
