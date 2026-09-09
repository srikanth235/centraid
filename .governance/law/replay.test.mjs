// The catalog, pointed at a real change that already merged (#1005).
//
// A rule catalog that has only ever seen its own fixtures is a catalog of
// opinions. #1002's squash is a thousand-file change that landed on the trunk
// under the old regime, and replaying it is what makes "this would have caught
// it" a fact: the law and the product moved in one commit, and nothing was
// written to the changelog.
//
// The expectation file holds `rules` and `messages` only. Digests are stripped
// deliberately — they move with the working tree, and a fixture that has to be
// regenerated on every unrelated commit is a fixture people stop reading.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { runLaw } from "./run.mjs";

const HERE = import.meta.dirname;
const RANGE = "bb964a7e..3df6d552";
const EXPECTED = path.join(HERE, "fixtures", "replay", "1002.json");

/**
 * Reduce a run to the part that is a fact about the change rather than about
 * the tree it was replayed in.
 *
 * @param {object} report The runner's report.
 * @returns {object} The comparable shape.
 */
function comparable(report) {
  const order = (rows) => [...rows].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  return {
    range: RANGE,
    rules: order(
      report.rules.map((rule) => ({
        id: rule.id,
        door: rule.door,
        severity: rule.severity,
        verdict: rule.verdict,
        count: rule.count,
      }))
    ).sort((a, b) => (a.id < b.id ? -1 : 1)),
    messages: order(
      report.messages.map((message) => ({
        path: message.path,
        ruleId: message.ruleId,
        severity: message.severity,
        message: message.message,
      }))
    ),
  };
}

test("replaying #1002's squash reproduces the recorded findings exactly", async () => {
  const { report } = await runLaw({ door: "window", range: RANGE });
  assert.deepEqual(comparable(report), JSON.parse(readFileSync(EXPECTED, "utf8")));
});

test("the replay is not vacuous: it names the failures #1002 would have had", async () => {
  const expected = JSON.parse(readFileSync(EXPECTED, "utf8"));
  const by = (id) => expected.messages.filter((message) => message.ruleId === `law/${id}`);
  const estate = by("estate-separation");
  assert.equal(estate.length, 1, "the law and the territory moved in one commit");
  assert.match(estate[0].message, /tests\/claims\.json/u);
  assert.match(estate[0].message, /tests\/inventory\.json/u);
  assert.match(estate[0].message, /and \d{3,} more/u, "a thousand territory files rode along");
  const registry = by("registry-completeness");
  assert.equal(registry.length, 1);
  assert.match(registry[0].message, /CHANGELOG\.md carries no line citing #996/u);
  // The uncited ruling: #1002's receipt wrote two rules down and cited nothing
  // for either, which is how doctrine drifts with no decision being reversed.
  const doctrine = by("doctrine-citation");
  assert.equal(doctrine.length, 2);
  assert.match(doctrine[0].message, /receipts\/issue-996-one-vault-every-seat\.md:\d+/u);
  assert.match(doctrine[0].message, /records ruling W6-D[12] and cites nothing/u);
  // Every waiver #1002 spent is still in the record — seven of them — but the
  // register they would be held against did not exist at #1002's head, and the
  // arrival now reads the docket there rather than out of whatever checkout is
  // replaying it (R-1005-27). "Not yet established" is the honest verdict for
  // this range; the rule's spending half is exercised by its own suite.
  const { arrival } = await runLaw({ door: "window", range: RANGE });
  assert.equal(arrival.registries.docket.exists, false);
  assert.equal(arrival.waivers.length, 7, "the spends are recorded even when no register judges them");
  assert.equal(by("waiver-docket").length, 0);
  // The four ported rules passed on it, which is the control: the two new
  // directives are catching something the old catalog genuinely could not.
  for (const id of ["commit-message-format", "doc-integrity", "receipt-per-issue"]) {
    assert.equal(expected.rules.find((rule) => rule.id === id).verdict, "pass");
  }
});
