import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";
import vitest from "ultracite/oxlint/vitest";

import { oversizedFiles } from "./scripts/lint-oversized-files.mjs";
import { typeAwareOnlyRules } from "./scripts/lint-types-rules.mjs";

// ---------------------------------------------------------------------------
// #656 Layer 4 — test seams as merge blockers.
//
// TESTING.md says "prefer the kit". Prose does not survive contact with an
// agent writing the twentieth test file of a session, so the three seams whose
// hand-rolled forms actually caused defects are mechanical here. Each entry
// names the kit helper that replaces it; a ban with no shorter alternative is
// just friction, so the helper landed first.
//
// `Date.now()` is deliberately NOT on this list. oxlint 1.76 has no
// `no-restricted-syntax`, so the defect's real shape — wall clock read *inside*
// an assertion's expected value — is not expressible; only a blanket property
// ban is. That ban would touch 162 call sites, of which the sampled majority
// are relative offsets (`Date.now() + 60_000`), unique id suffixes, and elapsed
// measurement in perf rigs. A fake clock makes those wrong, not better, so the
// rule would buy a rename and no determinism. See docs/coding-standards.md.
const TEST_SEAM_PROPERTIES = [
  {
    property: "mkdtemp",
    message:
      "Use tempDir() from @centraid/test-kit/temp-dir — it registers the removal at creation, so a failing test cannot leak the directory. See docs/coding-standards.md, test seams.",
  },
  {
    property: "mkdtempSync",
    message:
      "Use tempDirSync() from @centraid/test-kit/temp-dir — it registers the removal at creation, so a failing test cannot leak the directory. See docs/coding-standards.md, test seams.",
  },
  {
    object: "vi",
    property: "useFakeTimers",
    message:
      "Use useFakeClock() from @centraid/test-kit/fake-clock — it restores real timers even when the test throws, so a fake clock cannot leak into later tests as a hang. See docs/coding-standards.md, test seams.",
  },
  {
    object: "vi",
    property: "useRealTimers",
    message:
      "useFakeClock() from @centraid/test-kit/fake-clock already restores real timers; call clock.restore() if a test needs it early. See docs/coding-standards.md, test seams.",
  },
  {
    object: "vi",
    property: "setSystemTime",
    message:
      "Use clock.set() from useFakeClock() (@centraid/test-kit/fake-clock) — setting the system time without owning its restore is what leaks. See docs/coding-standards.md, test seams.",
  },
  {
    object: "Math",
    property: "random",
    message:
      "Use seededRandom() from @centraid/test-kit/random — a failure found from an unseeded draw is not reproducible from the failing run's own output. See docs/coding-standards.md, test seams.",
  },
] as const;

const TEMP_DIR_IMPORT_MESSAGE =
  "Import tempDir()/tempDirSync() from @centraid/test-kit/temp-dir instead — the kit owns the removal. See docs/coding-standards.md, test seams.";

const TEST_SEAM_IMPORTS = {
  paths: [
    {
      name: "node:fs",
      importNames: ["mkdtemp", "mkdtempSync"],
      message: TEMP_DIR_IMPORT_MESSAGE,
    },
    {
      name: "node:fs/promises",
      importNames: ["mkdtemp"],
      message: TEMP_DIR_IMPORT_MESSAGE,
    },
    {
      name: "fs",
      importNames: ["mkdtemp", "mkdtempSync"],
      message: TEMP_DIR_IMPORT_MESSAGE,
    },
    {
      name: "fs/promises",
      importNames: ["mkdtemp"],
      message: TEMP_DIR_IMPORT_MESSAGE,
    },
  ],
  // An override replaces the root rule's configuration rather than merging
  // with it, so the repo-wide deep-import ban is restated here. Dropping it
  // would silently ungate every test file.
  patterns: [
    {
      group: ["@centraid/*/src/*", "@centraid/*/dist/*"],
      message:
        "Import from the package root barrel (e.g. '@centraid/design/elements'), not its internals — keeps each package's public surface the real contract. See governance: no-deep-imports.",
    },
  ],
};

// The vitest-owned test files. The Playwright specs under `desktop/e2e` and
// `extension/e2e` are named `*.e2e.ts`, so no glob here reaches them.
const VITEST_TEST_FILES = [
  "**/*.{test,spec}.{ts,tsx}",
  // #781 — `.test.mjs` was invisible to the seam rules (11 files carried raw
  // mkdtemp*). Widened, not carved: node:test-runner files that genuinely
  // cannot import the kit (tempDir() registers a vitest afterAll at import
  // time) suppress per-line with a justification instead of being excluded
  // here wholesale.
  "**/*.test.mjs",
  "**/*.test-fixtures.ts",
];

// Ultracite is the reviewed policy seed; Oxlint is the only routine lint
// command and this file is the repository's only lint configuration.
// core + react are extended, while vitest is NOT: it applies
// entirely through "overrides", and an extended preset's overrides outrank the
// consumer's, so `extends: [vitest]` would leave no way to order the repo's
// own vitest corrections after it. Its override is therefore spliced into
// `overrides` below verbatim — same rules, same glob — which makes ordering
// ours. See TESTING.md, "ultracite vitest preset (#573)".
export default defineConfig({
  extends: [core, react],
  options: {
    denyWarnings: true,
    reportUnusedDisableDirectives: "deny",
    // The pinned TypeScript compiler owns compiler diagnostics. The separate
    // compatibility pass in scripts/lint-types.sh admits only proven rules.
    typeAware: false,
    typeCheck: false,
  },
  ignorePatterns: (core.ignorePatterns ?? []).concat(["**/dist/**"]),
  rules: {
    // Ultracite's core preset contains type-aware rules. They cannot execute
    // with options.typeAware=false, so force the complete pinned engine
    // surface off here; scripts/lint-types.sh admits eight rules explicitly.
    ...Object.fromEntries(typeAwareOnlyRules.map((rule) => [rule, "off"])),
    // Rules ultracite 7.9's presets newly enable. Issue #210 fixed this
    // repo's profile as correctness + suspicious + perf with explicit
    // opinions, so these are pinned off rather than silently adopted. The
    // count after each is what turning it back on would cost today, so a
    // family can be adopted on its own terms later.
    //
    // The jsx-a11y family was the first to be adopted on its own terms
    // (#573): all ten rules are back on the preset's defaults and their 223
    // sites are fixed with native elements, not suppressions. Nothing from
    // that family belongs in this list again. Families C-F followed; what is
    // left in this list is what survived being audited, not what was skipped.
    //
    // Every loop must declare whether its work is independent (concurrent) or
    // intentionally ordered. Raw awaits in loops obscure that contract, so the
    // rule applies equally to production code and test scenarios. Ordered work
    // belongs behind a named, tested primitive; independent work uses bounded
    // or unbounded concurrency as its resource contract permits. #573
    "no-await-in-loop": "error",

    // Repo profile (#210).
    "arrow-body-style": "off",
    "class-methods-use-this": "off",
    complexity: "off",
    curly: "off",
    "default-case": "off",
    eqeqeq: ["error", "always", { null: "ignore" }],
    "func-names": "off",
    "func-style": "off",
    "import/consistent-type-specifier-style": "error",
    // The file-length ceiling (#615's 625 lines), back under oxlint after
    // governance-kit audit 0.11.0 retired the `repo-hygiene` directive that
    // owned it: same raw-line count, ~0.4s against that directive's 51.2s. The
    // 131 files predating it are exempt by name in the down-only
    // tests/inventory.json#fileSize.
    "max-lines": ["error", { max: 625 }],
    "no-accumulating-spread": "off",
    "no-alert": "off",
    "no-bitwise": "off",
    "no-console": "off",
    "no-else-return": "off",
    "no-empty-function": "off",
    "no-eq-null": "off",
    "no-inline-comments": "off",
    "no-lonely-if": "off",
    "no-loop-func": "off",
    "no-negated-condition": "off",
    "no-nested-ternary": "off",
    "no-plusplus": "off",
    "no-promise-executor-return": "error",
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: ["@centraid/*/src/*", "@centraid/*/dist/*"],
            message:
              "Import from the package root barrel (e.g. '@centraid/design/elements'), not its internals \u2014 keeps each package's public surface the real contract. See governance: no-deep-imports.",
          },
        ],
      },
    ],
    "no-shadow": "error",
    "no-throw-literal": "error",
    "no-unmodified-loop-condition": "error",
    "no-use-before-define": "off",
    "no-useless-constructor": "off",
    "no-void": "off",
    "no-warning-comments": "off",
    "prefer-const": "error",
    "prefer-destructuring": "off",
    "prefer-object-spread": "off",
    "prefer-template": "off",
    "promise/avoid-new": "off",
    "promise/no-nesting": "off",
    "promise/no-promise-in-callback": "off",
    "promise/prefer-await-to-callbacks": "off",
    "promise/prefer-await-to-then": "off",
    // react/react-compiler already validates referential stability across the
    // repository. Enabling these older heuristic rules as well would duplicate
    // that owner and flag constructions the compiler proves safe.
    "react-perf/jsx-no-new-function-as-prop": "off",
    "react/exhaustive-deps": "error",
    "react/jsx-curly-brace-presence": "off",
    "react/jsx-no-constructed-context-values": "off",
    "react/jsx-no-useless-fragment": "off",
    "react/no-array-index-key": "off",
    "react/no-danger": "error",
    "react/no-unescaped-entities": "off",
    "react/rules-of-hooks": "error",
    "react/style-prop-object": "off",
    "require-await": "off",
    "sort-keys": "off",
    "typescript/array-type": "off",
    "typescript/ban-ts-comment": "error",
    "typescript/consistent-type-definitions": "off",
    "typescript/consistent-type-imports": [
      "error",
      { disallowTypeAnnotations: false },
    ],
    "typescript/no-dynamic-delete": "off",
    "typescript/no-empty-interface": "off",
    "typescript/no-empty-object-type": "off",
    "typescript/no-explicit-any": "error",
    "typescript/no-import-type-side-effects": "error",
    "typescript/no-inferrable-types": "off",
    "typescript/no-invalid-void-type": "off",
    "typescript/no-non-null-assertion": "off",
    // Keep this compatibility boundary visible even though the catalog above
    // also disables it: tsgolint removes assertions still required by
    // TypeScript 5.9 under noUncheckedIndexedAccess and in typed mocks.
    "typescript/no-unnecessary-type-assertion": "off",
    "typescript/parameter-properties": "off",
    "unicorn/catch-error-name": "error",
    "unicorn/consistent-existence-index-check": "off",
    "unicorn/consistent-function-scoping": "off",
    "unicorn/filename-case": "off",
    "unicorn/no-array-for-each": "off",
    "unicorn/no-array-reduce": "off",
    "unicorn/no-array-sort": "off",
    "unicorn/no-await-expression-member": "off",
    "unicorn/no-hex-escape": "off",
    "unicorn/no-immediate-mutation": "error",
    "unicorn/no-lonely-if": "off",
    "unicorn/no-nested-ternary": "off",
    "unicorn/no-object-as-default-parameter": "error",
    "unicorn/no-typeof-undefined": "off",
    "unicorn/no-useless-undefined": "off",
    "unicorn/number-literal-case": "off",
    "unicorn/numeric-separators-style": "off",
    "unicorn/prefer-at": "off",
    "unicorn/prefer-code-point": "off",
    "unicorn/prefer-dom-node-append": "off",
    "unicorn/prefer-logical-operator-over-ternary": "off",
    "unicorn/prefer-math-min-max": "off",
    "unicorn/prefer-math-trunc": "off",
    "unicorn/prefer-module": "off",
    "unicorn/prefer-negative-index": "off",
    "unicorn/prefer-number-properties": "off",
    "unicorn/prefer-response-static-json": "off",
    "unicorn/prefer-set-has": "off",
    "unicorn/prefer-spread": "off",
    "unicorn/prefer-string-replace-all": "off",
    "unicorn/prefer-string-slice": "off",
    "unicorn/prefer-ternary": "off",
    "unicorn/prefer-type-error": "off",
    "unicorn/switch-case-braces": "off",
    "unicorn/text-encoding-identifier-case": "off",
  },
  overrides: [
    {
      // A ledger row, not an inline `oxlint-disable`: a suppression is free
      // to add; a row has to survive the budget.
      files: oversizedFiles,
      rules: { "max-lines": "off" },
    },
    {
      // This deliberate negative fixture proves the corresponding type-aware
      // rules emit. Disable only the ordinary equivalents so the fixture
      // remains linted by every unrelated rule.
      files: ["scripts/fixtures/lint-types/invalid.ts"],
      rules: {
        "no-throw-literal": "off",
        "prefer-promise-reject-errors": "off",
      },
    },
    // The vitest preset applies through `overrides`, and an extended preset's
    // overrides outrank the consumer's — so extending it leaves no way to say
    // "not these files". Its single override is therefore spliced in here
    // verbatim (rules unchanged, glob unchanged: wholesale adoption) purely so
    // the corrections below can be ordered after it.
    ...vitest.overrides,
    {
      // The two rules in the preset that trade assertion precision for
      // brevity, and the only two that contradict a rule this repo already
      // documents: TESTING.md's test convention says "Prefer specific matchers
      // and meaningful expected values over `toBeTruthy()`". `expect(x).toBe(true)`
      // asserts x is exactly the boolean true; `expect(x).toBeTruthy()` also
      // passes for 1, 'x', [], {}. Autofixing the preset over this suite
      // rewrites 1,117 `toBe(true)` and 720 `toBe(false)` into strictly weaker
      // assertions. Everything else in the preset is adopted as-is; these two
      // are held off deliberately. See TESTING.md, "ultracite vitest preset (#573)".
      files: [
        "**/*.{test,spec}.{ts,tsx,js,jsx}",
        "**/__tests__/**/*.{ts,tsx,js,jsx}",
      ],
      plugins: ["vitest"],
      rules: {
        "vitest/prefer-to-be-falsy": "off",
        "vitest/prefer-to-be-truthy": "off",
        // The rule defaults to jest's signature, where `expect` takes exactly
        // one argument. vitest's takes an optional second one — the message
        // printed when the assertion fails, e.g.
        // `expect(res.status, JSON.stringify(body)).toBe(400)`. Complying with
        // the default would mean deleting those messages, which is the opposite
        // of the "clear failure output" rule in TESTING.md. This corrects the
        // rule for the runner rather than relaxing it: everything else it
        // checks still applies.
        "vitest/valid-expect": ["error", { maxArgs: 2 }],
        // The preset's default is 5. This suite is deliberately built around
        // integration-shaped tests that drive one scenario and then assert the
        // whole resulting state — splitting those to satisfy a count would mean
        // re-running the setup per assertion, which changes what is under test
        // and slows the suite for no coverage gain. Measured sensitivity across
        // the suite: max 5 -> 2030 findings, 10 -> 448, 15 -> 162, 20 -> 68,
        // 30 -> 26. The reviewed ceiling is 31: it still catches sprawling
        // tests while allowing one behavior-focused integration scenario to
        // assert a compact contract matrix without a count-driven split.
        "vitest/max-expects": ["error", { max: 31 }],
      },
    },
    {
      // #656 Layer 4 — the test seams.
      files: VITEST_TEST_FILES,
      rules: {
        "no-restricted-properties": ["error", ...TEST_SEAM_PROPERTIES],
        "no-restricted-imports": ["error", TEST_SEAM_IMPORTS],
      },
    },
  ],
});
