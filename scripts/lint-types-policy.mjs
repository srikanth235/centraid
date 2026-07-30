import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  compatibilityRules,
  fixtureRules,
  typeAwareOnlyRules,
} from "./lint-types-rules.mjs";

const ordinaryConfigPath = "oxlint.config.ts";
const typeAwareScriptPath = "scripts/lint-types.sh";
const fixturePath = "scripts/fixtures/lint-types/invalid.ts";
const fixtureTsconfigPath = "scripts/fixtures/lint-types/tsconfig.json";

const ordinaryConfig = readFileSync(ordinaryConfigPath, "utf8");
const typeAwareScript = readFileSync(typeAwareScriptPath, "utf8");

for (const rule of compatibilityRules) {
  const occurrences = typeAwareScript.split(rule).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `${rule} must be declared exactly once in ${typeAwareScriptPath}; found ${occurrences}`
    );
  }
}

const resolvedConfigResult = spawnSync(
  "node_modules/.bin/oxlint",
  ["-c", ordinaryConfigPath, "--disable-nested-config", "--print-config"],
  { encoding: "utf8" }
);
if (resolvedConfigResult.status !== 0) {
  throw new Error(
    `cannot resolve ${ordinaryConfigPath}: ${resolvedConfigResult.stderr}`
  );
}
const resolvedConfig = JSON.parse(resolvedConfigResult.stdout);
const activeTypeAwareRules = typeAwareOnlyRules.filter((rule) => {
  const severity = resolvedConfig.rules?.[rule];
  return severity !== "allow" && severity !== "off" && severity !== 0;
});
if (activeTypeAwareRules.length > 0) {
  throw new Error(
    `type-aware-only rules are active in the ordinary pass: ${activeTypeAwareRules.join(", ")}`
  );
}

if (
  !/["']typescript\/no-unnecessary-type-assertion["']\s*:\s*["']off["']/u.test(
    ordinaryConfig
  )
) {
  throw new Error(
    "typescript/no-unnecessary-type-assertion must remain explicitly disabled while TypeScript 5.9 is authoritative"
  );
}

const fixtureBaseArgs = [
  "-c",
  ordinaryConfigPath,
  "--type-aware",
  "--format=json",
  "--disable-nested-config",
  // Ordinary lint owns directive hygiene. This pass disables ordinary rules
  // with -A all, so it cannot meaningfully decide whether their directives
  // are unused.
  "--report-unused-disable-directives-severity=allow",
  "-A",
  "all",
  "--tsconfig",
  fixtureTsconfigPath,
];
const baselineResult = spawnSync(
  "node_modules/.bin/oxlint",
  [...fixtureBaseArgs, fixturePath],
  { encoding: "utf8" }
);
if (baselineResult.error) throw baselineResult.error;
const baselineReport = JSON.parse(baselineResult.stdout);
if (
  !Number.isInteger(baselineReport.number_of_rules) ||
  baselineReport.number_of_files !== 1
) {
  throw new Error(
    `cannot establish the type-aware fixture baseline: ${baselineResult.stdout}`
  );
}
const baselineRuleCount = baselineReport.number_of_rules;

for (const rule of fixtureRules) {
  const result = spawnSync(
    "node_modules/.bin/oxlint",
    [...fixtureBaseArgs, "-D", rule, fixturePath],
    { encoding: "utf8" }
  );

  if (result.error) throw result.error;

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `${rule} fixture did not return JSON: ${result.stderr || error.message}`,
      { cause: error }
    );
  }

  const diagnostics = Array.isArray(report.diagnostics)
    ? report.diagnostics
    : [];
  const emittedRuleIds = diagnostics.map(
    (diagnostic) => diagnostic.ruleId ?? diagnostic.code
  );
  const expectedRuleId = `${rule.replace("typescript/", "typescript(")})`;
  if (
    result.status !== 1 ||
    report.number_of_rules !== baselineRuleCount + 1 ||
    report.number_of_files !== 1 ||
    !emittedRuleIds.includes(expectedRuleId)
  ) {
    throw new Error(
      `${rule} fixture was hollow: ${JSON.stringify({
        status: result.status,
        numberOfRules: report.number_of_rules,
        numberOfFiles: report.number_of_files,
        emittedRuleIds,
        stderr: result.stderr,
      })}`
    );
  }
}

console.log(
  `ok   type-aware policy (${compatibilityRules.length} single-pass rules; ${fixtureRules.length} live fixtures; baseline ${baselineRuleCount})`
);
