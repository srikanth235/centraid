import assert from "node:assert/strict";
import test from "node:test";

import {
  CANDIDATE_REF,
  parseLastGreenRun,
  parseLsRemote,
  resolveCandidate,
} from "./resolve-candidate.mjs";

const SHA = "a".repeat(40);
const GREEN = "b".repeat(40);

test("parseLsRemote reads the SHA and refuses anything else", () => {
  assert.equal(parseLsRemote(`${SHA}\t${CANDIDATE_REF}\n`), SHA);
  assert.equal(parseLsRemote(""), null);
  assert.equal(parseLsRemote("not-a-sha\trefs/x"), null);
});

test("parseLastGreenRun takes the newest success, skipping reds", () => {
  const stdout = JSON.stringify({
    workflow_runs: [
      { conclusion: "failure", head_sha: SHA },
      { conclusion: "success", head_sha: GREEN },
    ],
  });
  assert.equal(parseLastGreenRun(stdout), GREEN);
  assert.equal(parseLastGreenRun("{}"), null);
  assert.equal(parseLastGreenRun("nope"), null);
});

const resolve = (overrides) =>
  resolveCandidate({
    ref: "",
    fallbackSha: "c".repeat(40),
    candidatePointer: () => null,
    lastGreenGate: () => null,
    ...overrides,
  });

test("a dispatch ref wins and nothing else is consulted", () => {
  let consulted = false;
  const result = resolve({
    ref: " main ",
    candidatePointer: () => {
      consulted = true;
      return SHA;
    },
  });
  assert.equal(result.sha, "main");
  assert.equal(result.source, "dispatch-input");
  assert.equal(consulted, false);
});

test("the promoted pointer beats the last green gate", () => {
  const result = resolve({
    candidatePointer: () => SHA,
    lastGreenGate: () => GREEN,
  });
  assert.equal(result.sha, SHA);
  assert.equal(result.source, "candidate-pointer");
});

test("with no candidate yet, the last green ci.yml run is used and named weaker", () => {
  const result = resolve({ lastGreenGate: () => GREEN });
  assert.equal(result.sha, GREEN);
  assert.equal(result.source, "last-green-ci");
  assert.match(result.note, /WEAKER claim/u);
});

test("the last resort is the workflow's own SHA, announced as such", () => {
  const result = resolve({});
  assert.equal(result.sha, "c".repeat(40));
  assert.equal(result.source, "workflow-sha");
  assert.match(result.note, /pre-#915 behaviour/u);
});
