// Fail-path proof for `bun run lint:e2e-flows` (issue #656 Layer 1F).
// A linter that always exits 0 is worse than no linter: these assert that each
// rule REJECTS a synthetic violation and ACCEPTS the compliant twin.
import assert from "node:assert/strict";
import test from "node:test";

import { lintFlowSource } from "./lint-e2e-flows.mjs";

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
