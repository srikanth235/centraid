import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  allFileCompatibilityRules,
  blueprintCompatibilityRules,
  compatibilityRules,
  fixtureRules,
  sourceOnlyCompatibilityRules,
  typeAwareCatalogVersion,
  typeAwareOnlyRules,
} from "./lint-types-rules.mjs";

const ordinaryConfigPath = "oxlint.config.ts";
const fixturePath = "scripts/fixtures/lint-types/invalid.ts";
const fixtureTsconfigPath = "scripts/fixtures/lint-types/tsconfig.json";

const ordinaryConfig = readFileSync(ordinaryConfigPath, "utf8");
const rootPackage = JSON.parse(readFileSync("package.json", "utf8"));
const installedTypeAwarePackage = JSON.parse(
  readFileSync("node_modules/oxlint-tsgolint/package.json", "utf8")
);
const installedTypeAwareReadme = readFileSync(
  "node_modules/oxlint-tsgolint/README.md",
  "utf8"
);

if (
  rootPackage.devDependencies?.["oxlint-tsgolint"] !==
    typeAwareCatalogVersion ||
  installedTypeAwarePackage.version !== typeAwareCatalogVersion
) {
  throw new Error(
    `type-aware catalog targets oxlint-tsgolint ${typeAwareCatalogVersion}, but package.json/installed versions are ${rootPackage.devDependencies?.["oxlint-tsgolint"]}/${installedTypeAwarePackage.version}; regenerate scripts/lint-types-rules.mjs before upgrading`
  );
}

if (
  new Set(typeAwareOnlyRules).size !== typeAwareOnlyRules.length ||
  new Set(compatibilityRules).size !== compatibilityRules.length ||
  new Set(blueprintCompatibilityRules).size !==
    blueprintCompatibilityRules.length ||
  compatibilityRules.some((rule) => !typeAwareOnlyRules.includes(rule))
) {
  throw new Error(
    "type-aware catalogs must be unique and the compatibility allowlist must be a subset of the installed-engine catalog"
  );
}

const installedTypeAwareRules = [
  ...installedTypeAwareReadme.matchAll(
    /^- \[x\] \[(?<rule>[^\]]+)\]\([^)]+\)$/gmu
  ),
].map((match) => `typescript/${match.groups.rule}`);
const catalogOnlyRules = typeAwareOnlyRules.filter(
  (rule) => !installedTypeAwareRules.includes(rule)
);
const engineOnlyRules = installedTypeAwareRules.filter(
  (rule) => !typeAwareOnlyRules.includes(rule)
);
if (
  installedTypeAwareRules.length === 0 ||
  catalogOnlyRules.length > 0 ||
  engineOnlyRules.length > 0
) {
  throw new Error(
    `type-aware catalog differs from the installed engine manifest: ${JSON.stringify(
      { catalogOnlyRules, engineOnlyRules }
    )}; regenerate scripts/lint-types-rules.mjs before upgrading`
  );
}

if (
  blueprintCompatibilityRules.some(
    (rule) => !allFileCompatibilityRules.includes(rule)
  ) ||
  blueprintCompatibilityRules.includes("typescript/no-misused-promises")
) {
  throw new Error(
    "blueprint compatibility rules must be an all-file subset with the documented callback-return exception"
  );
}

if (
  fixtureRules.length !== compatibilityRules.length ||
  fixtureRules.some((rule) => !compatibilityRules.includes(rule))
) {
  throw new Error(
    "every compatibility rule must have exactly one live negative fixture"
  );
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

function isActive(severity) {
  const configuredSeverity = Array.isArray(severity) ? severity[0] : severity;
  return (
    configuredSeverity !== undefined &&
    configuredSeverity !== "allow" &&
    configuredSeverity !== "off" &&
    configuredSeverity !== 0
  );
}

const activeTypeAwareDeclarations = [];
for (const rule of typeAwareOnlyRules) {
  if (isActive(resolvedConfig.rules?.[rule])) {
    activeTypeAwareDeclarations.push(`rules.${rule}`);
  }
}
for (const [index, override] of (resolvedConfig.overrides ?? []).entries()) {
  for (const rule of typeAwareOnlyRules) {
    if (isActive(override.rules?.[rule])) {
      activeTypeAwareDeclarations.push(`overrides[${index}].rules.${rule}`);
    }
  }
}
if (activeTypeAwareDeclarations.length > 0) {
  throw new Error(
    `type-aware-only rules are active in the ordinary pass: ${activeTypeAwareDeclarations.join(", ")}`
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

const catalogProbeResult = spawnSync(
  "node_modules/.bin/oxlint",
  [
    ...fixtureBaseArgs,
    ...typeAwareOnlyRules.flatMap((rule) => ["-D", rule]),
    fixturePath,
  ],
  { encoding: "utf8" }
);
if (catalogProbeResult.error) throw catalogProbeResult.error;
const catalogProbeReport = JSON.parse(catalogProbeResult.stdout);
if (
  catalogProbeReport.number_of_rules !==
  baselineRuleCount + typeAwareOnlyRules.length
) {
  throw new Error(
    `installed type-aware engine did not register the complete catalog: expected ${baselineRuleCount + typeAwareOnlyRules.length} rules, got ${catalogProbeReport.number_of_rules}`
  );
}

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
  `ok   type-aware policy (${compatibilityRules.length} single-pass rules: ${allFileCompatibilityRules.length} all-file + ${sourceOnlyCompatibilityRules.length} source-only; ${fixtureRules.length} live fixtures; ${typeAwareOnlyRules.length}-rule engine catalog ${typeAwareCatalogVersion}; baseline ${baselineRuleCount})`
);
