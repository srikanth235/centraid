// Every `invalid` case is the cardinal rule being broken: a rule edited without
// its cases, a rule added that no pack enables, and a severity or a door moved
// without the constitution section that states it.
import rule from "./amendment-pairing.mjs";
import { ruleTester } from "../lib/rule.mjs";

const ruleFile = (id, status = "M") => ({
  path: `.governance/law/rules/${id}.mjs`,
  status,
  estate: "law",
});
const testFile = (id, status = "M") => ({
  path: `.governance/law/rules/${id}.test.mjs`,
  status,
  estate: "law",
});
const statute = { path: "CONSTITUTION.md", status: "M", estate: "law" };

const commit = (sha, files) => ({
  sha,
  subject: "feat(governance): a rule (#1005)",
  body: "",
  parents: ["p"],
  files,
});

/**
 * A minimal arrival record.
 *
 * @param {object} parts Its interesting sections.
 * @returns {string} The record.
 */
const record = (parts) =>
  JSON.stringify(
    {
      schema: 5,
      commits: parts.commits ?? [],
      files: parts.files ?? [],
      pending: parts.pending ?? null,
      law: {
        rules: parts.rules ?? { "estate-separation": { severity: "warn", door: "hook" } },
        rulesAtBase:
          parts.rulesAtBase ?? { "estate-separation": { severity: "warn", door: "hook" } },
      },
      ...(parts.stamp ? { stamp: parts.stamp } : {}),
    },
    null,
    2
  );

ruleTester().run("amendment-pairing", rule, {
  valid: [
    // The expected shape: rule, cases, and the pack row that already exists.
    record({
      commits: [commit("a1", [ruleFile("estate-separation"), testFile("estate-separation")])],
      files: [ruleFile("estate-separation"), testFile("estate-separation")],
    }),
    // A new rule, its cases, and a pack row enabling it.
    record({
      commits: [commit("a1", [ruleFile("waiver-docket", "A"), testFile("waiver-docket", "A")])],
      rules: {
        "estate-separation": { severity: "warn", door: "hook" },
        "waiver-docket": { severity: "warn", door: "hook" },
      },
    }),
    // A severity move, with the statute moving in the same change.
    record({
      commits: [commit("a1", [statute])],
      files: [statute],
      rules: { "estate-separation": { severity: "error", door: "hook" } },
    }),
    // A merge commit has no diff of its own.
    record({
      commits: [{ ...commit("m1", [ruleFile("estate-separation")]), parents: ["p", "q"] }],
    }),
    // At the hook door only the staged set is judged.
    record({
      commits: [commit("a1", [ruleFile("estate-separation")])],
      stamp: { door: "hook" },
      pending: { message: "x", files: [] },
    }),
    // The cases are staged even though the rule landed in the commit before.
    record({
      commits: [commit("a1", [ruleFile("estate-separation")])],
      pending: { message: "x", files: [testFile("estate-separation")] },
    }),
    // A rule that did not exist at the baseline is an addition, and its
    // section is `constitution-coverage`'s question rather than this one's.
    record({
      rules: {
        "estate-separation": { severity: "warn", door: "hook" },
        "doctrine-citation": { severity: "warn", door: "window" },
      },
    }),
  ],
  invalid: [
    {
      code: record({
        commits: [commit("a1", [ruleFile("estate-separation")])],
        files: [ruleFile("estate-separation")],
      }),
      errors: [{ message: /changes \.governance\/law\/rules\/estate-separation\.mjs but not/u }],
    },
    {
      code: record({
        pending: { message: "x", files: [ruleFile("estate-separation")] },
        stamp: { door: "hook" },
      }),
      errors: [{ message: /the staged change changes/u }],
    },
    {
      code: record({
        commits: [commit("a1", [ruleFile("brand-new", "A"), testFile("brand-new", "A")])],
      }),
      errors: [{ message: /which no pack enables/u }],
    },
    {
      code: record({
        commits: [commit("a1", [ruleFile("estate-separation"), testFile("estate-separation")])],
        files: [ruleFile("estate-separation"), testFile("estate-separation")],
        rules: { "estate-separation": { severity: "error", door: "hook" } },
      }),
      errors: [{ message: /severity changed \(warn → error\) with no change to CONSTITUTION\.md/u }],
    },
    {
      code: record({
        rules: { "estate-separation": { severity: "warn", door: "window" } },
      }),
      errors: [{ message: /door changed \(hook → window\)/u }],
    },
  ],
});
