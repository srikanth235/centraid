#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

function baseJson(file) {
  try {
    return JSON.parse(
      execFileSync("git", ["show", `origin/main:${file}`], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
    );
  } catch {
    return null;
  }
}

function currentJson(file) {
  return JSON.parse(readFileSync(path.join(root, file), "utf8"));
}

const errors = [];
const changed = new Set(
  [
    ...execFileSync("git", ["diff", "--name-only", "origin/main", "--"], {
      cwd: root,
      encoding: "utf8",
    }).split("\n"),
    ...execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
    }).split("\n"),
  ].filter(Boolean)
);
function approved(config) {
  const note = config.approvedDeviation;
  if (typeof note !== "string" || !/#\d+/u.test(note)) return false;
  return [...changed]
    .filter((file) => /^receipts\/issue-\d+-.*\.md$/u.test(file))

    .filter((file) => existsSync(path.join(root, file)))
    .some((file) => {
      const receipt = readFileSync(path.join(root, file), "utf8");
      return /^## Decisions\s*$/mu.test(receipt) && receipt.includes(note);
    });
}
const experienceFiles =
  currentJson("tests/budgets.json").experience?.files ?? [];
const queryFile = experienceFiles.find((file) =>
  file.endsWith("client-query-counts.json")
);
if (!queryFile) {
  console.error(
    "quality-knobs: tests/budgets.json#experience.files does not name client-query-counts.json"
  );
  process.exit(1);
}
const queryBase = baseJson(queryFile);
const queryCurrent = currentJson(queryFile);
if (queryBase) {
  for (const [screen, budget] of Object.entries(queryCurrent.screens ?? {})) {
    const prior = queryBase.screens?.[screen];
    if (!prior) continue;
    for (const key of ["sqlStatements", "httpRequests"]) {
      if (Number(budget[key]) > Number(prior[key]) && !approved(queryCurrent))
        errors.push(
          `${queryFile}: ${screen}.${key} widened without approvedDeviation`
        );
    }
  }
  for (const screen of Object.keys(queryBase.screens ?? {}))
    if (
      !Object.hasOwn(queryCurrent.screens ?? {}, screen) &&
      !approved(queryCurrent)
    )
      errors.push(`${queryFile}: screen budget ${screen} was removed`);
}

for (const file of [
  "tests/quality/copy-allowlist.json",
  "tests/quality/unbounded-query-waivers.json",
]) {
  const base = baseJson(file);
  const current = currentJson(file);
  if (base) {
    const prior = new Set(
      (base.entries ?? []).map((entry) => JSON.stringify(entry))
    );
    const next = new Set(
      (current.entries ?? []).map((entry) => JSON.stringify(entry))
    );
    const changedEntries =
      [...prior].some((entry) => !next.has(entry)) ||
      [...next].some((entry) => !prior.has(entry));
    if (changedEntries && !approved(current))
      errors.push(
        `${file}: allowlist/waiver entries changed without a receipt-approved deviation`
      );
  }
}

const classificationFile = "tests/quality/classification-ratchet.json";
const classificationBase = baseJson(classificationFile);
const classificationCurrent = currentJson(classificationFile);
for (const [file, fingerprint] of Object.entries(
  classificationCurrent.fingerprints ?? {}
)) {
  const actual = createHash("sha256")
    .update(readFileSync(path.join(root, file)))
    .digest("hex");
  if (actual !== fingerprint)
    errors.push(`${classificationFile}: stale fingerprint for ${file}`);
}
if (
  classificationBase &&
  JSON.stringify(classificationBase.fingerprints) !==
    JSON.stringify(classificationCurrent.fingerprints) &&
  !approved(classificationCurrent)
)
  errors.push(
    `${classificationFile}: governed classifications changed without a receipt-approved deviation`
  );

const claimsBase = baseJson("tests/claims.json");
const claimsCurrent = currentJson("tests/claims.json");
const claimsGovernedPayload = JSON.stringify({ claims: claimsCurrent.claims });
const claimsGovernanceFingerprint = createHash("sha256")
  .update(claimsGovernedPayload)
  .digest("hex");
if (
  classificationCurrent.claimsGovernanceFingerprint !==
  claimsGovernanceFingerprint
)
  errors.push(
    `${classificationFile}: stale claimsGovernanceFingerprint; a claim row's owner, evidence selector, severity, or demonstrated-red date changed`
  );
if (
  classificationBase?.claimsGovernanceFingerprint &&
  classificationBase.claimsGovernanceFingerprint !==
    classificationCurrent.claimsGovernanceFingerprint &&
  !approved(classificationCurrent)
)
  errors.push(
    `${classificationFile}: governed claims changed without a receipt-approved deviation`
  );
if (Array.isArray(claimsBase?.claims)) {
  const prior = new Set(claimsBase.claims.map((claim) => claim.id));
  const current = new Set(
    (claimsCurrent.claims ?? []).map((claim) => claim.id)
  );
  for (const id of prior) {
    if (!current.has(id))
      errors.push(`tests/claims.json: claim ${id} was removed`);
  }
}

if (errors.length) {
  for (const error of errors) console.error(`quality knob: ${error}`);
  process.exit(1);
}
console.log("quality knob governance: no silent widening");
