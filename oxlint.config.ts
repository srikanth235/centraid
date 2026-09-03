import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";
import vitest from "ultracite/oxlint/vitest";

import { typeAwareOnlyRules } from "./scripts/lint-types-rules.mjs";

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
  patterns: [
    {
      group: ["@centraid/*/src/*", "@centraid/*/dist/*"],
      message:
        "Import from the package root barrel (e.g. '@centraid/server/engine'), not its internals — keeps each package's public surface the real contract. See governance: no-deep-imports.",
    },
  ],
};

const VITEST_TEST_FILES = [
  "**/*.{test,spec}.{ts,tsx}",
  "**/*.test.mjs",
  "**/*.test-fixtures.ts",
  "tests/helpers/**/*.ts",
  "tests/agent-e2e-*/**/*.mjs",
];

const HERMES_ARRAY_PROPERTIES = [
  {
    property: "toSorted",
    message:
      "The reviewed Hermes runtime does not implement Array.prototype.toSorted; sort a fresh array with .sort instead.",
  },
] as const;

export default defineConfig({
  extends: [core, react],
  options: {
    denyWarnings: true,
    reportUnusedDisableDirectives: "deny",
    typeAware: false,
    typeCheck: false,
  },
  ignorePatterns: (core.ignorePatterns ?? []).concat([
    "**/dist/**",
    "**/.expo/**",
    "**/node_modules/**",
    "apps/oauth-worker/worker-configuration.d.ts",
    "apps/web/src/generated/**",
    "packages/blueprints/automations/photo-ocr/automations/photo-ocr/handler.js",
    "packages/blueprints/automations/embed-image/automations/embed-image/handler.js",
    "packages/blueprints/automations/embed-text/automations/embed-text/handler.js",
    "packages/blueprints/automations/faces/automations/faces/handler.js",
    "packages/blueprints/automations/place-names/automations/place-names/handler.js",
    "packages/blueprints/automations/transcript/automations/transcript/handler.js",
  ]),
  rules: {
    ...Object.fromEntries(typeAwareOnlyRules.map((rule) => [rule, "off"])),
    "no-await-in-loop": "error",

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
              "Import from the package root barrel (e.g. '@centraid/server/engine'), not its internals \u2014 keeps each package's public surface the real contract. See governance: no-deep-imports.",
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
      files: ["packages/client/src/index.ts"],
      rules: {
        "oxc/no-barrel-file": "off",
      },
    },
    {
      files: ["scripts/fixtures/lint-types/invalid.ts"],
      rules: {
        "no-throw-literal": "off",
        "prefer-promise-reject-errors": "off",
      },
    },
    ...vitest.overrides,
    {
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
      files: ["tests/agent-e2e-*/**/*.mjs"],
      env: {
        browser: false,
        es2024: true,
        node: true,
      },
      rules: {
        "no-undef": "error",
      },
    },
    {
      files: ["tests/agent-e2e-pairing/flows/extension-companion.mjs"],
      globals: {
        chrome: "readonly",
        document: "readonly",
      },
    },
    {
      files: [
        "**/*.{test,spec}.{ts,tsx,js,jsx}",
        "**/__tests__/**/*.{ts,tsx,js,jsx}",
      ],
      plugins: ["vitest"],
      rules: {
        "vitest/prefer-to-be-falsy": "off",
        "vitest/prefer-to-be-truthy": "off",
        "vitest/valid-expect": ["error", { maxArgs: 2 }],
        "vitest/max-expects": ["error", { max: 31 }],
      },
    },
    {
      files: ["apps/desktop/tests/e2e/**", "apps/web/tests/e2e/**"],
      plugins: ["vitest"],
      rules: Object.fromEntries(
        Object.keys(vitest.overrides[0].rules)
          .filter((rule) => rule.startsWith("vitest/"))
          .map((rule) => [rule, "off"])
      ),
    },
    {
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
      files: ["packages/server/src/engine/**/*.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: [
                  "@centraid/*",
                  "../automation",
                  "../automation/*",
                  "../acp",
                  "../acp/*",
                ],
                message:
                  "engine is the stable core of the server DAG — it must not import automation, acp, or other @centraid packages. Seams are path-based after #801.",
              },
            ],
          },
        ],
      },
    },
    {
      files: ["packages/server/src/automation/**/*.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: [
                  "@centraid/server/acp",
                  "@centraid/server/acp/*",
                  "../acp",
                  "../acp/*",
                ],
                message:
                  "automation must not import the ACP turn driver — execution is an injected callback. Seams are path-based after #801.",
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
      files: ["apps/mobile/src/**", "packages/core/src/time/**"],
      rules: {
        "no-restricted-properties": ["error", ...HERMES_ARRAY_PROPERTIES],
      },
    },
    {
      files: VITEST_TEST_FILES,
      rules: {
        "no-restricted-properties": ["error", ...TEST_SEAM_PROPERTIES],
        "no-restricted-imports": ["error", TEST_SEAM_IMPORTS],
      },
    },
    {
      files: [
        "apps/mobile/src/**/*.{test,spec}.{ts,tsx}",
        "apps/mobile/src/**/*.test-fixtures.ts",
        "packages/core/src/time/**/*.{test,spec}.{ts,tsx}",
        "packages/core/src/time/**/*.test-fixtures.ts",
      ],
      rules: {
        "no-restricted-properties": [
          "error",
          ...HERMES_ARRAY_PROPERTIES,
          ...TEST_SEAM_PROPERTIES,
        ],
        "no-restricted-imports": ["error", TEST_SEAM_IMPORTS],
      },
    },
    {
      files: ["apps/desktop/tests/e2e/**", "apps/web/tests/e2e/**"],
      rules: {
        "no-restricted-properties": "off",
        "no-restricted-imports": [
          "error",
          { patterns: TEST_SEAM_IMPORTS.patterns },
        ],
      },
    },
  ],
});
