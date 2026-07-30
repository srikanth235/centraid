import { pathToFileURL } from "node:url";

// oxlint-tsgolint's implemented type-aware-only rules. The version handshake
// in lint-types-policy.mjs makes an engine upgrade fail closed until this
// catalog has been regenerated and reviewed.
export const typeAwareCatalogVersion = "7.0.2001";

export const typeAwareOnlyRules = [
  "typescript/await-thenable",
  "typescript/consistent-return",
  "typescript/consistent-type-exports",
  "typescript/dot-notation",
  "typescript/no-array-delete",
  "typescript/no-base-to-string",
  "typescript/no-confusing-void-expression",
  "typescript/no-deprecated",
  "typescript/no-duplicate-type-constituents",
  "typescript/no-floating-promises",
  "typescript/no-for-in-array",
  "typescript/no-implied-eval",
  "typescript/no-meaningless-void-operator",
  "typescript/no-misused-promises",
  "typescript/no-misused-spread",
  "typescript/no-mixed-enums",
  "typescript/no-redundant-type-constituents",
  "typescript/no-unnecessary-boolean-literal-compare",
  "typescript/no-unnecessary-condition",
  "typescript/no-unnecessary-qualifier",
  "typescript/no-unnecessary-template-expression",
  "typescript/no-unnecessary-type-arguments",
  "typescript/no-unnecessary-type-assertion",
  "typescript/no-unnecessary-type-conversion",
  "typescript/no-unnecessary-type-parameters",
  "typescript/no-unsafe-argument",
  "typescript/no-unsafe-assignment",
  "typescript/no-unsafe-call",
  "typescript/no-unsafe-enum-comparison",
  "typescript/no-unsafe-member-access",
  "typescript/no-unsafe-return",
  "typescript/no-unsafe-type-assertion",
  "typescript/no-unsafe-unary-minus",
  "typescript/no-useless-default-assignment",
  "typescript/non-nullable-type-assertion-style",
  "typescript/only-throw-error",
  "typescript/prefer-find",
  "typescript/prefer-includes",
  "typescript/prefer-nullish-coalescing",
  "typescript/prefer-optional-chain",
  "typescript/prefer-promise-reject-errors",
  "typescript/prefer-readonly-parameter-types",
  "typescript/prefer-readonly",
  "typescript/prefer-reduce-type-parameter",
  "typescript/prefer-regexp-exec",
  "typescript/prefer-return-this-type",
  "typescript/prefer-string-starts-ends-with",
  "typescript/promise-function-async",
  "typescript/related-getter-setter-pairs",
  "typescript/require-array-sort-compare",
  "typescript/require-await",
  "typescript/restrict-plus-operands",
  "typescript/restrict-template-expressions",
  "typescript/return-await",
  "typescript/strict-boolean-expressions",
  "typescript/strict-void-return",
  "typescript/switch-exhaustiveness-check",
  "typescript/unbound-method",
  "typescript/use-unknown-in-catch-callback-variable",
];

export const allFileCompatibilityRules = [
  "typescript/no-misused-promises",
  "typescript/await-thenable",
  "typescript/switch-exhaustiveness-check",
  "typescript/no-for-in-array",
  "typescript/only-throw-error",
  "typescript/prefer-promise-reject-errors",
  "typescript/require-array-sort-compare",
];

export const sourceOnlyCompatibilityRules = ["typescript/no-floating-promises"];

export const compatibilityRules = [
  ...allFileCompatibilityRules,
  ...sourceOnlyCompatibilityRules,
];

export const fixtureRules = [...compatibilityRules];

// Blueprint React/DOM callback slots intentionally launch narrated async
// actions. The engine's CLI cannot retain condition checks while disabling
// void-return callbacks, and wrapping 126 handlers in `void` would only erase
// the type signal without adding rejection handling.
export const blueprintCompatibilityRules = allFileCompatibilityRules.filter(
  (rule) => rule !== "typescript/no-misused-promises"
);

function printRules(group) {
  const groups = {
    all: allFileCompatibilityRules,
    blueprint: blueprintCompatibilityRules,
    source: sourceOnlyCompatibilityRules,
  };
  const rules = groups[group];
  if (!rules) {
    throw new Error(`unknown lint-types rule group: ${group}`);
  }
  process.stdout.write(`${rules.join("\n")}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  printRules(process.argv[2]);
}
