import assert from "node:assert/strict";
import test from "node:test";

import { advisorySteps, checkAdvisories } from "./advisory-expiry.mjs";

const WORKFLOW = `
jobs:
  a:
    steps:
      - uses: actions/checkout@abc
      - name: Advisory — Expo compatibility map (non-blocking)
        continue-on-error: true
        run: echo hi
      - name: Report generated binding drift (non-blocking)
        run: echo hi
      - name: Ordinary blocking step
        run: echo hi
`;

const ENTRY = {
  owner: "some lane",
  issue: "#892",
  revisitBy: "2027-01-01",
  why: "because",
};

test("advisorySteps finds the self-declared advisories and nothing else", () => {
  const steps = advisorySteps("ci.yml", WORKFLOW);
  assert.deepEqual(
    steps.map((step) => step.name),
    [
      "Advisory — Expo compatibility map (non-blocking)",
      "Report generated binding drift (non-blocking)",
    ]
  );
});

test("an unregistered advisory fails", () => {
  const errors = checkAdvisories(
    [{ id: "ci.yml: Advisory X" }],
    {},
    "2026-08-31"
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no entry in tests\/inventory\.json#advisory/u);
});

test("a registered, unexpired advisory passes", () => {
  assert.deepEqual(
    checkAdvisories(
      [{ id: "ci.yml: Advisory X" }],
      { "ci.yml: Advisory X": ENTRY },
      "2026-08-31"
    ),
    []
  );
});

test("a PAST revisitBy fails — that is the whole point", () => {
  const errors = checkAdvisories(
    [{ id: "ci.yml: Advisory X" }],
    { "ci.yml: Advisory X": { ...ENTRY, revisitBy: "2026-01-01" } },
    "2026-08-31"
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /due for a decision on 2026-01-01/u);
});

test("a missing field is named individually", () => {
  const errors = checkAdvisories(
    [{ id: "ci.yml: Advisory X" }],
    { "ci.yml: Advisory X": { revisitBy: "2027-01-01" } },
    "2026-08-31"
  );
  assert.equal(errors.length, 3);
  for (const field of ["owner", "issue", "why"]) {
    assert.ok(
      errors.some((error) => error.includes(field)),
      field
    );
  }
});

test("a non-ISO revisitBy is refused rather than string-compared", () => {
  assert.match(
    checkAdvisories(
      [{ id: "ci.yml: Advisory X" }],
      { "ci.yml: Advisory X": { ...ENTRY, revisitBy: "soon" } },
      "2026-08-31"
    )[0],
    /not an ISO date/u
  );
});

test("a ledger entry for a step that no longer exists fails as stale", () => {
  const errors = checkAdvisories(
    [],
    { "ci.yml: Advisory Gone": ENTRY },
    "2026-08-31"
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no longer exists/u);
});

test("the `_comment` key is not mistaken for a stale entry", () => {
  assert.deepEqual(
    checkAdvisories([], { _comment: "why this file exists" }, "2026-08-31"),
    []
  );
});
