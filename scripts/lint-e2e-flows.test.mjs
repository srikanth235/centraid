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

/** A throwaway repo shaped like the real one: `<root>/tests/agent-e2e-mobile/
 * {flows,lib}` populated with the given `dir/name` files. */
function fixtureRoot(files) {
  const root = mkdtempSync(path.join(tmpdir(), "e2e-flow-roster-"));
  for (const dir of ["flows", "lib"])
    mkdirSync(path.join(root, "tests/agent-e2e-mobile", dir), {
      recursive: true,
    });
  for (const [rel, body] of Object.entries(files))
    writeFileSync(path.join(root, "tests/agent-e2e-mobile", rel), body);
  return root;
}

test("discovery picks up a flow dropped on disk, with no linter edit", () => {
  const root = fixtureRoot({
    "flows/brand-new-journey.mjs": '- assertVisible: "Something"\n',
    "lib/harness.mjs": "",
  });
  assert.deepEqual(discoverFiles(root), [
    "tests/agent-e2e-mobile/flows/brand-new-journey.mjs",
    "tests/agent-e2e-mobile/lib/harness.mjs",
  ]);
});

test("discovery skips non-.mjs files and `*.test.mjs` siblings", () => {
  const root = fixtureRoot({
    "flows/real.mjs": "",
    "flows/real.md": "",
    "lib/frame-report.mjs": "",
    "lib/frame-report.test.mjs": "",
  });
  assert.deepEqual(discoverFiles(root), [
    "tests/agent-e2e-mobile/flows/real.mjs",
    "tests/agent-e2e-mobile/lib/frame-report.mjs",
  ]);
});

test("the real roster covers every flow file on disk", () => {
  const files = discoverFiles();
  const onDisk = readdirSync(
    path.resolve(import.meta.dirname, "../tests/agent-e2e-mobile/flows")
  )
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => `tests/agent-e2e-mobile/flows/${name}`)
    .sort();
  assert.deepEqual(
    files.filter((f) => f.includes("/flows/")),
    onDisk
  );
  // Including the journeys the old hand-written list forgot.
  for (const forgotten of [
    "photos-library",
    "photos-permissions",
    "photos-search",
    "photos-select-write",
    "photos-viewer",
    "volume-proof",
  ])
    assert.ok(
      files.includes(`tests/agent-e2e-mobile/flows/${forgotten}.mjs`),
      `${forgotten} must be linted`
    );
});

test("SABOTAGE: a flow with a vacuous assertion is caught through discovery", () => {
  const root = fixtureRoot({
    // Exactly the shape that escaped: a new journey nobody added to a list.
    "flows/sneaky.mjs": '- tapOn: "Photos.*"\n- assertVisible: "Photos"\n',
  });
  const [rel] = discoverFiles(root);
  assert.equal(rel, "tests/agent-e2e-mobile/flows/sneaky.mjs");
  assert.deepEqual(rules(readFileSync(path.join(root, rel), "utf8")), [
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
