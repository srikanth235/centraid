// @ts-nocheck — RuleTester fixtures are partial arrival records.
// The runner's own tests (#1005).
//
// The catalog is empty in this wave, so what is under test is the machinery a
// rule will arrive into: that an empty law is green and silent, that a rule
// that fires prints one line and one finding, that the hook door is fatal and
// the window door is not, and that the front page renders the same run.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { buildConfig, loadRules } from "./eslint.config.ts";
import { briefDrift, main, printReport, runLaw } from "./run.ts";
import { defineRule } from "./lib/rule.ts";
import { nameFiles, renderFrontPage, renderRegistries } from "./front-page.ts";

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
    // The arrival record, the docket, and the governance documents.
    assert.equal(config.length, 3);
    assert.equal(config[0].language, "json/json");
    assert.equal(config[1].language, "json/json");
    assert.equal(config[2].language, "markdown/commonmark");
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

test("the hook door is fatal for every rule it runs; the window door is not", async () => {
  // The catalog's one asymmetry (#1005, R-1005-14). At the hook door the author
  // is still holding the change and a rule that cannot refuse is a rule for
  // nothing, so every rule that runs there is an error whatever its pack row
  // says. At the window door the pack row is the authority, so a rule whose
  // host backing the owner has not confirmed reports without standing in for a
  // review that has not happened.
  const atHook = await runLaw({ door: "hook", arrival: ARRIVAL, rules: catalog("hook", "warn") });
  assert.equal(atHook.report.messages[0].severity, "error");
  const atWindow = await runLaw({ door: "window", arrival: ARRIVAL, rules: catalog("hook", "warn") });
  assert.equal(atWindow.report.messages[0].severity, "warn");
  // A hook rule the pack declares at `error` is still an error in the window —
  // softening one would be weakening policy without editing it.
  const declared = await runLaw({ door: "window", arrival: ARRIVAL, rules: catalog("hook", "error") });
  assert.equal(declared.report.messages[0].severity, "error");
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

test("the registry lines are generated from the record, including the silences", () => {
  // A blank where a line belongs reads as "nothing to say"; "no rulings
  // recorded" is a claim the law is making, and nobody could have typed it in.
  const quiet = renderRegistries(null);
  for (const expected of [
    "- no rulings recorded",
    "- no changelog entry",
    "- no gates moved",
    "- no waivers used",
    "- docket not yet established",
    "- proposal link unverified (offline)",
    "- token cost: not recorded",
  ]) {
    assert.ok(quiet.includes(expected), `the front page dropped '${expected}'`);
  }
  const loud = renderRegistries({
    registries: {
      changelog: { issues: [1005] },
      decisions: { issues: [1005] },
      docket: { path: ".governance/law/docket.json", exists: true, rows: [] },
      receipts: { files: [{ path: "receipts/issue-1005-x.md", touched: true, cost: "12k tokens" }] },
    },
    gates: [{ path: "tests/floors.json", direction: "widened" }],
    waivers: [
      { directive: "estate-separation", path: null, reason: "a reason", source: "commit:abc" },
      { directive: "doc-integrity", path: null, reason: "", source: "commit:abc" },
    ],
    ci: { issueIsProposal: true },
  }).join("\n");
  assert.match(loud, /- rulings recorded: #1005 in `docs\/decisions\.md`/u);
  assert.match(loud, /- changelog entries: #1005/u);
  assert.match(loud, /- gates moved: `tests\/floors\.json` \(widened\)/u);
  assert.match(loud, /- waiver used: `estate-separation` — a reason \(commit:abc\)/u);
  assert.ok(!loud.includes("doc-integrity"), "a waiver with no reason is not a waiver");
  assert.ok(!loud.includes("docket not yet established"));
  assert.ok(!loud.includes("proposal link unverified"));
  assert.match(loud, /- token cost: receipts\/issue-1005-x\.md: 12k tokens/u);
});

test("a brief's stamp says what the agent was not told", async () => {
  const { execFileSync } = await import("node:child_process");
  const root = path.resolve(import.meta.dirname, "..", "..");
  const at = (rev) =>
    execFileSync("git", ["rev-parse", rev], { cwd: root, encoding: "utf8" }).trim();
  const range = { base: at("HEAD~1"), head: at("HEAD") };
  const { lawDigestAt } = await import("./arrival.ts");

  assert.equal(briefDrift(undefined, range), null, "no stamp, no claim");
  const current = briefDrift(lawDigestAt(range.head), range);
  assert.deepEqual(current.changed, [], "a brief stamped at HEAD saw everything");
  assert.equal(current.at, range.head);
  // A stamp naming a state no commit in the range carries is reported as
  // unknown rather than as "nothing moved" — the honest answer.
  const stranger = briefDrift("0".repeat(64), range);
  assert.equal(stranger.at, null);
  assert.deepEqual(stranger.changed, []);
});

test("the front page names at most twelve paths, then counts the rest", () => {
  assert.equal(nameFiles([]), "(unnamed)");
  assert.equal(nameFiles(["a", "b"]), "`a`, `b`");
  const many = Array.from({ length: 70 }, (_, index) => `f${index}`);
  const rendered = nameFiles(many);
  assert.match(rendered, /and 58 more$/u);
  assert.equal(rendered.split("`f").length - 1, 12);
  const page = renderFrontPage({
    door: "window",
    lawDigest: { base: "a".repeat(64), head: "b".repeat(64) },
    lawChanged: many,
    brief: { stamped: "c".repeat(64), head: "b".repeat(64), at: null, changed: [] },
    range: { base: "a", head: "b" },
    rules: [],
    messages: [],
  });
  assert.match(page, /law changed under this run: `f0`.*and 58 more/u);
  assert.match(page, /brief stamped `cccccccccccc`, HEAD is `bbbbbbbbbbbb` — changed: unknown commit/u);
});
