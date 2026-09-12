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
} from "./lint-types-rules.ts";

const ordinaryConfigPath = "oxlint.config.ts";
const fixturePath = "scripts/fixtures/lint-types/invalid.ts";
const fixtureTsconfigPath = "scripts/fixtures/lint-types/tsconfig.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ordinaryConfig = readFileSync(ordinaryConfigPath, "utf8");
const rootPackageRaw: unknown = JSON.parse(
  readFileSync("package.json", "utf8")
);
const rootPackage = isRecord(rootPackageRaw) ? rootPackageRaw : {};
const installedTypeAwarePackageRaw: unknown = JSON.parse(
  readFileSync("node_modules/oxlint-tsgolint/package.json", "utf8")
);
const installedTypeAwarePackage = isRecord(installedTypeAwarePackageRaw)
  ? installedTypeAwarePackageRaw
  : {};
const installedTypeAwareReadme = readFileSync(
  "node_modules/oxlint-tsgolint/README.md",
  "utf8"
);

if (
  (isRecord(rootPackage.devDependencies)
    ? rootPackage.devDependencies["oxlint-tsgolint"]
    : undefined) !== typeAwareCatalogVersion ||
  installedTypeAwarePackage.version !== typeAwareCatalogVersion
) {
  throw new Error(
    `type-aware catalog targets oxlint-tsgolint ${typeAwareCatalogVersion}, but package.json/installed versions are ${isRecord(rootPackage.devDependencies) ? rootPackage.devDependencies["oxlint-tsgolint"] : undefined}/${installedTypeAwarePackage.version}; regenerate scripts/lint-types-rules.ts before upgrading`
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

// The installed engine package publishes its implemented-rule manifest in the
// bundled README. Compare that engine-owned surface with the reviewed catalog
// so a newly implemented rule cannot be omitted merely because the local
// catalog and the command assembled from it still agree with each other.
const installedTypeAwareRules = [
  ...installedTypeAwareReadme.matchAll(
    /^- \[x\] \[(?<rule>[^\]]+)\]\([^)]+\)$/gmu
  ),
].map((match) => `typescript/${match.groups?.rule}`);
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
    )}; regenerate scripts/lint-types-rules.ts before upgrading`
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
const resolvedConfigRaw: unknown = JSON.parse(resolvedConfigResult.stdout);
const resolvedConfig = isRecord(resolvedConfigRaw) ? resolvedConfigRaw : {};

function isActive(severity: unknown): boolean {
  const configuredSeverity = Array.isArray(severity) ? severity[0] : severity;
  return (
    configuredSeverity !== undefined &&
    configuredSeverity !== "allow" &&
    configuredSeverity !== "off" &&
    configuredSeverity !== 0
  );
}

const activeTypeAwareDeclarations: string[] = [];
const resolvedRules = isRecord(resolvedConfig.rules)
  ? resolvedConfig.rules
  : {};
for (const rule of typeAwareOnlyRules) {
  if (isActive(resolvedRules[rule])) {
    activeTypeAwareDeclarations.push(`rules.${rule}`);
  }
}
const overrides = Array.isArray(resolvedConfig.overrides)
  ? resolvedConfig.overrides
  : [];
for (const [index, override] of overrides.entries()) {
  const overrideRules =
    isRecord(override) && isRecord(override.rules) ? override.rules : {};
  for (const rule of typeAwareOnlyRules) {
    if (isActive(overrideRules[rule])) {
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
const baselineReportRaw: unknown = JSON.parse(baselineResult.stdout);
const baselineReport = isRecord(baselineReportRaw) ? baselineReportRaw : {};
if (
  !Number.isInteger(baselineReport.number_of_rules) ||
  baselineReport.number_of_files !== 1
) {
  throw new Error(
    `cannot establish the type-aware fixture baseline: ${baselineResult.stdout}`
  );
}
const baselineRuleCount =
  typeof baselineReport.number_of_rules === "number"
    ? baselineReport.number_of_rules
    : 0;

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
const catalogProbeReportRaw: unknown = JSON.parse(catalogProbeResult.stdout);
const catalogProbeReport = isRecord(catalogProbeReportRaw)
  ? catalogProbeReportRaw
  : {};
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

  let report: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    report = isRecord(parsed) ? parsed : {};
  } catch (error) {
    throw new Error(
      `${rule} fixture did not return JSON: ${result.stderr || (error instanceof Error ? error.message : String(error))}`,
      { cause: error }
    );
  }

  const diagnostics = Array.isArray(report.diagnostics)
    ? report.diagnostics
    : [];
  const emittedRuleIds = diagnostics.map((diagnostic: unknown) => {
    if (!isRecord(diagnostic)) return undefined;
    return diagnostic.ruleId ?? diagnostic.code;
  });
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
