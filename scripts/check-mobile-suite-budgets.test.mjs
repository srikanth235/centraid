// Unit spec for the mobile suite-budget ratchet's MERGE-BASE READ (#915 Wave 2).
//
// `checkBudgets` has always had a self-test that runs on every invocation, over
// injected runners and an injected `baseOf`. What that cannot cover is the thing
// Wave 2 changed: WHERE the previous ceiling is found. The numbers moved out of
// seven `const BUDGET_MS` literals into `roster.json`, and one suite was
// renamed on the way (`pr-gate-resilience` -> `resilience`, at a new rung). Both
// moves are the shape that resets a ratchet to "new suite, no base" — which is
// the one answer that always works and always costs the gate its meaning.
//
// So this file drives `baseBudgetMs` over a stubbed `git show`, with no repo
// state involved: the real lookup depends on what `origin/main` happens to be,
// and a ratchet whose only test is "whatever the checkout says" is not a test.

import assert from "node:assert/strict";
import test from "node:test";

import { baseBudgetMs, readSuites } from "./check-mobile-suite-budgets.mjs";

const MOBILE = "tests/agent-e2e-mobile";

/** A `git show` stub: `{ "<ref>:<file>": contents }`. */
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
  // `resilience` is `pr-gate-resilience` at a new rung. Without this, the
  // rename would report "new suite, no base" and hand back the ratchet.
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
  // The seam this change crosses exactly once: the merge base still has seven
  // runner files and a roster with no `suites` block.
  const tree = {
    [`origin/main:${MOBILE}/roster.json`]: JSON.stringify({ flows: {} }),
    [`origin/main:${MOBILE}/run-pr-gate-suite.mjs`]:
      "const BUDGET_MS = 12 * 60_000;\n",
    [`origin/main:${MOBILE}/run-probes-suite.mjs`]:
      "const BUDGET_MS = 35 * 60_000;\n",
  };
  assert.equal(baseBudgetMs("pr-gate", undefined, show(tree)), 12 * 60_000);
  // Two spellings, because the suite id and the retired file name only
  // sometimes agree: `probes-suite` lived in `run-probes-suite.mjs`.
  assert.equal(
    baseBudgetMs("probes-suite", undefined, show(tree)),
    35 * 60_000
  );
});

test("a stale first ref does not end the search", () => {
  // `origin/main` can legitimately predate the suite in a shallow or lagging
  // checkout. Stopping there would report "new suite" and drop the ratchet, so
  // the lookup falls through to `main`.
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
