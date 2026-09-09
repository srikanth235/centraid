// The runner's own tests (#1005).
//
// The catalog is empty in this wave, so what is under test is the machinery a
// rule will arrive into: that an empty law is green and silent, that a rule
// that fires prints one line and one finding, that the hook door is fatal and
// the window door is not, and that the front page renders the same run.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { buildConfig, loadRules } from "./eslint.config.mjs";
import { main, printReport, runLaw } from "./run.mjs";
import { defineRule } from "./lib/rule.mjs";
import { renderFrontPage } from "./front-page.mjs";

const HERE = import.meta.dirname;
const ARRIVAL = path.join(HERE, "fixtures", "arrival", "bb964a7e..3df6d552.json");

/** A rule that always fires once, on the record's `schema` member. */
const alwaysFires = defineRule({
  id: "smoke-always-fires",
  statute: "#the-arrival-record",
  door: "hook",
  description: "Fire once on every arrival record, so the runner has something to report.",
  observes: "nothing real — this rule exists only in the runner's tests.",
  create(context) {
    return {
      Document(node) {
        context.report({ node, message: "smoke" });
      },
    };
  },
});

/**
 * A one-rule catalog for a door.
 *
 * @param {"hook"|"window"} door The door to declare it at.
 * @param {"error"|"warn"} [severity] The severity the pack row declares.
 * @returns {object[]} A rows array shaped like `loadRules()`.
 */
const catalog = (door, severity = "warn") => [
  { id: "smoke-always-fires", severity, door, surface: "arrival", rule: alwaysFires },
];

test("an empty law is green, silent, and still says which door ran", async () => {
  const { report } = await runLaw({ door: "hook", arrival: ARRIVAL, rules: [] });
  assert.deepEqual(report.rules, []);
  assert.deepEqual(report.messages, []);
  assert.equal(report.door, "hook");
});

test("the declared catalog resolves and both doors build a config", async () => {
  const declared = await loadRules();
  assert.ok(declared.length > 0, "the packs declare no rules");
  for (const row of declared) {
    assert.equal(typeof row.rule?.meta?.docs?.url, "string", `${row.id} has no statute link`);
    assert.ok(["hook", "window", "owner"].includes(row.door));
  }
  const configs = await Promise.all(["hook", "window"].map((door) => buildConfig(door)));
  for (const config of configs) {
    assert.equal(config.length, 2);
    assert.equal(config[0].language, "json/json");
    assert.equal(config[1].language, "markdown/commonmark");
    for (const block of config) {
      assert.equal(block.linterOptions.reportUnusedDisableDirectives, "error");
    }
  }
});

test("a rule that fires is one line, one finding, and fatal at the hook door", async () => {
  const { report } = await runLaw({ door: "hook", arrival: ARRIVAL, rules: catalog("hook", "error") });
  assert.deepEqual(report.rules, [
    { id: "smoke-always-fires", door: "hook", severity: "error", verdict: "fail", count: 1 },
  ]);
  assert.equal(report.messages.length, 1);
  assert.equal(report.messages[0].ruleId, "law/smoke-always-fires");
  assert.equal(report.messages[0].severity, "error");
});

test("a window rule takes the severity its pack row declares", async () => {
  const warned = await runLaw({ door: "window", arrival: ARRIVAL, rules: catalog("window", "warn") });
  assert.equal(warned.report.rules[0].verdict, "fail");
  assert.equal(warned.report.messages[0].severity, "warn");
  // The door decides which rules run; it may not quieten one the pack declared
  // at `error`, or porting a blocking check into a warning would be a way to
  // weaken policy without editing it.
  const errored = await runLaw({ door: "window", arrival: ARRIVAL, rules: catalog("window", "error") });
  assert.equal(errored.report.messages[0].severity, "error");
});

test("a hook rule stays fatal when the window door runs the whole law", async () => {
  const { report } = await runLaw({ door: "window", arrival: ARRIVAL, rules: catalog("hook") });
  assert.equal(report.messages[0].severity, "error");
});

test("a hook rule stays fatal even when the window door runs the whole law", async () => {
  const { report } = await runLaw({ door: "window", arrival: ARRIVAL, rules: catalog("hook") });
  assert.equal(report.messages[0].severity, "error", "the window door may widen the law, never soften it");
});

test("the exit code is 1 for an error and 0 for a warning", async (t) => {
  t.mock.method(process.stdout, "write", () => true);
  assert.equal(await main(["--door", "hook", "--arrival", ARRIVAL], { rules: [] }), 0);
  assert.equal(
    await main(["--door", "hook", "--arrival", ARRIVAL], { rules: catalog("hook") }),
    1,
    "an error-severity finding must fail the run"
  );
  assert.equal(
    await main(["--door", "window", "--arrival", ARRIVAL], { rules: catalog("window", "warn") }),
    0,
    "a warning is a report, not a refusal"
  );
});

test("every enabled rule prints a line whether it passed or failed", async (t) => {
  const written = [];
  t.mock.method(process.stdout, "write", (chunk) => {
    written.push(chunk);
    return true;
  });
  printReport({
    door: "window",
    rules: [
      { id: "a-passing-rule", door: "window", severity: "warn", verdict: "pass", count: 0 },
      { id: "a-failing-rule", door: "hook", severity: "error", verdict: "fail", count: 2 },
    ],
    messages: [
      { path: "x.json", line: 3, ruleId: "law/a-failing-rule", severity: "error", message: "no" },
      { path: "x.json", line: 4, ruleId: "law/a-failing-rule", severity: "error", message: "no" },
    ],
  });
  const out = written.join("");
  assert.match(out, /^✓ a-passing-rule$/mu, "a passing rule must still report");
  assert.match(out, /^✗ a-failing-rule — 2 findings$/mu);
  assert.match(out, /x\.json:3 law\/a-failing-rule — no/u);
});

test("the front page names the range, both law digests, and every rule", () => {
  const page = renderFrontPage({
    door: "window",
    range: { base: "bb964a7e0000", head: "3df6d5520000" },
    lawDigest: { base: "aaaaaaaaaaaaaaaa", head: "bbbbbbbbbbbbbbbb" },
    lawChanged: ["CONSTITUTION.md"],
    rules: [{ id: "a-rule", door: "hook", severity: "error", verdict: "pass", count: 0 }],
    messages: [],
  });
  assert.match(page, /bb964a7e\.\.3df6d552/u);
  assert.match(page, /law changed under this run: `CONSTITUTION\.md`/u);
  assert.match(page, /\| `a-rule` \| hook \| ✓ pass \| 0 \|/u);
  assert.match(page, /token cost: not recorded/u);
  assert.ok(page.endsWith("\n"));
});
