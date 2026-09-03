import assert from "node:assert/strict";
import test from "node:test";

import { baseBudgetMs, readSuites } from "./check-mobile-suite-budgets.mjs";

const MOBILE = "tests/agent-e2e-mobile";

const show = (tree) => (ref, file) => tree[`${ref}:${file}`];

test("the merge base's roster is the first place the ceiling is looked for", () => {
  const base = baseBudgetMs(
    "pr-gate",
    undefined,
    show({
      [`origin/main:${MOBILE}/roster.json`]: JSON.stringify({
        suites: { "pr-gate": { budgetMs: 720_000 } },
      }),
    })
  );
  assert.equal(base, 720_000);
});

test("a RENAMED suite inherits the ceiling of the suite it supersedes", () => {
  const base = baseBudgetMs(
    "resilience",
    "pr-gate-resilience",
    show({
      [`origin/main:${MOBILE}/roster.json`]: JSON.stringify({
        suites: { "pr-gate-resilience": { budgetMs: 720_000 } },
      }),
    })
  );
  assert.equal(base, 720_000);
});

test("a ceiling that has not moved into the roster yet is read from the retired runner", () => {
  const tree = {
    [`origin/main:${MOBILE}/roster.json`]: JSON.stringify({ flows: {} }),
    [`origin/main:${MOBILE}/run-pr-gate-suite.mjs`]:
      "const BUDGET_MS = 12 * 60_000;\n",
    [`origin/main:${MOBILE}/run-probes-suite.mjs`]:
      "const BUDGET_MS = 35 * 60_000;\n",
  };
  assert.equal(baseBudgetMs("pr-gate", undefined, show(tree)), 12 * 60_000);
  assert.equal(
    baseBudgetMs("probes-suite", undefined, show(tree)),
    35 * 60_000
  );
});

test("a stale first ref does not end the search", () => {
  const base = baseBudgetMs(
    "resilience",
    "pr-gate-resilience",
    show({
      [`origin/main:${MOBILE}/roster.json`]: JSON.stringify({ suites: {} }),
      [`main:${MOBILE}/run-pr-gate-resilience-suite.mjs`]:
        "const BUDGET_MS = 12 * 60_000;\n",
    })
  );
  assert.equal(base, 12 * 60_000);
});

test("a genuinely new suite has no base, and that is not an error", () => {
  assert.equal(
    baseBudgetMs(
      "ios-smoke",
      undefined,
      show({
        [`origin/main:${MOBILE}/roster.json`]: JSON.stringify({ suites: {} }),
      })
    ),
    null
  );
});

test("readSuites reads every shipped suite, and each prices itself", () => {
  const suites = readSuites();
  assert.ok(suites.length >= 8, "the shipped roster declares the suites");
  for (const suite of suites) {
    assert.ok(
      suite.budgetMs > 0,
      `${suite.file} declares no positive budgetMs`
    );
    assert.ok(suite.flows.length > 0, `${suite.file} declares no members`);
  }
});
