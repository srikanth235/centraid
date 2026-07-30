import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";
import vitest from "ultracite/oxlint/vitest";

import { typeAwareOnlyRules } from "./scripts/lint-types-rules.mjs";

// Ultracite is the reviewed policy seed; Oxlint is the only routine lint
// command and this file is the repository's only lint configuration.
// core + react are extended, while vitest is NOT: it applies
// entirely through "overrides", and an extended preset's overrides outrank the
// consumer's, so `extends: [vitest]` would leave no way to say "these rules,
// but not on the Playwright specs". Its override is therefore spliced into
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
  ignorePatterns: (core.ignorePatterns ?? []).concat([
    "**/dist/**",
    "**/.expo/**",
    "**/node_modules/**",
    "apps/oauth-worker/worker-configuration.d.ts",
    "apps/web/src/generated/**",
  ]),
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
    "max-lines": "off",
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
              "Import from the package root barrel (e.g. '@centraid/app-engine'), not its internals \u2014 keeps each package's public surface the real contract. See governance: no-deep-imports.",
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
      // This deliberate negative fixture proves the corresponding type-aware
      // rules emit. Disable only the ordinary equivalents so the fixture
      // remains linted by every unrelated rule.
      files: ["scripts/fixtures/lint-types/invalid.ts"],
      rules: {
        "no-throw-literal": "off",
        "prefer-promise-reject-errors": "off",
      },
    },
    {
      // This large ES5-style in-page store is fixture data for the visual
      // harness and is never shipped. Rewriting its syntax would add risk
      // without improving the product; keep the useful runtime undefined-name
      // check while leaving style to the fixture's established form.
      files: ["packages/blueprints/visual-harness/mock-centraid.js"],
      env: {
        browser: true,
        es2024: true,
        node: false,
      },
      rules: {
        ...Object.fromEntries(
          Object.keys(core.rules ?? {}).map((rule) => [rule, "off"])
        ),
        "no-undef": "error",
      },
    },
    // The vitest preset applies through `overrides`, and an extended preset's
    // overrides outrank the consumer's — so extending it leaves no way to say
    // "not these files". Its single override is therefore spliced in here
    // verbatim (rules unchanged, glob unchanged: wholesale adoption) purely so
    // the Playwright exclusion below can be ordered after it.
    ...vitest.overrides,
    {
      // Blueprint automation handlers execute under the gateway's handler
      // runtime. Connector pagination/batching is intentionally sequential,
      // because each cursor or page token depends on the prior response.
      // Every other rule from the root profile still applies.
      files: ["packages/blueprints/automations/**/handler.js"],
      env: {
        browser: false,
        es2024: true,
        node: true,
      },
      rules: {
        "no-await-in-loop": "off",
      },
    },
    {
      // Blueprint app handlers and seeds execute in the gateway's Bun/Node
      // runtime; app roots and kit modules remain browser-profiled.
      files: [
        "packages/blueprints/apps/**/actions/*.js",
        "packages/blueprints/apps/**/queries/*.js",
        "packages/blueprints/apps/**/seed.js",
      ],
      env: {
        browser: false,
        es2024: true,
        node: true,
      },
    },
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
      // The vitest glob `**/*.{test,spec}.*` also catches the Playwright e2e
      // specs — a different runner with its own `test`/`expect`. Left in scope,
      // `prefer-importing-vitest-globals` autofixes a `from 'vitest'` import on
      // top of the `@playwright/test` one and the files stop parsing. This is
      // about which runner owns the file, not about opting out of a rule.
      files: ["apps/desktop/tests/e2e/**", "apps/web/tests/e2e/**"],
      plugins: ["vitest"],
      rules: Object.fromEntries(
        Object.keys(vitest.overrides[0].rules)
          .filter((rule) => rule.startsWith("vitest/"))
          .map((rule) => [rule, "off"])
      ),
    },
    {
      // react/react-compiler was adopted repo-wide in #573 (714 real sites
      // fixed once the exhaustive-deps disables that made the compiler bail
      // per-component were stripped). These seven app-roots are the one
      // scoped exemption: the #505 imperative-shell architecture keeps all
      // state in refs (stateRef/logicRef/dashRef), lazily constructed during
      // render and mutated in place, which the compiler can never verify —
      // unmasking them reports 473 findings that are the design, not bugs.
      // Making them compiler-clean is a per-app state-model rewrite, tracked
      // in #573's receipt as follow-up work; laundering the refs through
      // useState just to satisfy the rule would be linter-gaming. Note
      // photos/app-root.tsx is NOT here — it had the same shape and was
      // genuinely converted, proving this list is architectural, not a dodge.
      files: [
        "packages/blueprints/apps/agenda/app-root.tsx",
        "packages/blueprints/apps/docs/app-root.tsx",
        "packages/blueprints/apps/locker/app-root.tsx",
        "packages/blueprints/apps/notes/app-root.tsx",
        "packages/blueprints/apps/people/app-root.tsx",
        "packages/blueprints/apps/tally/app-root.tsx",
        "packages/blueprints/apps/tasks/app-root.tsx",
      ],
      rules: {
        "react/react-compiler": "off",
      },
    },
    {
      files: ["packages/app-engine/**/*.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: ["@centraid/*"],
                message:
                  "app-engine is the stable core of the dependency DAG \u2014 it must not import other @centraid packages. Mode/runtime specifics belong at entrypoints (desktop main, gateway CLI). See governance: module-layering.",
              },
            ],
          },
        ],
      },
    },
    {
      files: ["packages/automation/**/*.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: [
                  "@centraid/agent-runtime",
                  "@centraid/agent-runtime/*",
                  "@centraid/gateway",
                  "@centraid/gateway/*",
                ],
                message:
                  "automation must not depend on an agent backend \u2014 execution and scheduling are injected callbacks (it depends on app-engine, never on agent-runtime/gateway). See governance: module-layering.",
              },
              {
                group: ["@centraid/*/src/*", "@centraid/*/dist/*"],
                message:
                  "Import from the package root barrel, not its internals. See governance: no-deep-imports.",
              },
            ],
          },
        ],
      },
    },
    {
      // The mobile app and time-engine execute in Hermes. The Expo 57 / RN
      // 0.86 runtime used by the reviewed iOS build does not implement these
      // ES2023 Array helpers: `toSorted` caused the native Photos cover to
      // redbox in the exact-HEAD journey, and time-engine is bundled into
      // native Agenda/Tally. Keep compatibility mechanical rather than relying
      // on Node-based unit tests, whose newer Array prototype masks the bug.
      files: ["apps/mobile/src/**", "packages/time-engine/src/**"],
      rules: {
        "no-restricted-properties": [
          "error",
          {
            property: "toSorted",
            message:
              "The reviewed Hermes runtime does not implement Array.prototype.toSorted; sort a fresh array with .sort instead.",
          },
          {
            property: "findLast",
            message:
              "Keep the mobile/time-engine bundle on the reviewed Hermes Array surface; use an explicit forward scan instead.",
          },
        ],
      },
    },
  ],
});
