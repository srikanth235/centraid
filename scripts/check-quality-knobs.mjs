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
  return (
    [...changed]
      .filter((file) => /^receipts\/issue-\d+-.*\.md$/u.test(file))
      // `changed` includes deletions — a receipt renamed away under a
      // doc-integrity waiver must not crash the gate; the surviving receipt
      // is the one that can carry the deviation note.
      .filter((file) => existsSync(path.join(root, file)))
      .some((file) => {
        const receipt = readFileSync(path.join(root, file), "utf8");
        return /^## Decisions\s*$/mu.test(receipt) && receipt.includes(note);
      })
  );
}
// The per-screen first-paint counts are one entry of the journey ledger
// (#927): `client/first-paint-work`, whose metrics are the screens. This gate
// holds them tighten-only per screen and refuses a silent screen deletion,
// which the ledger-wide ratchet alone would read as one fewer number.
const queryFile = "tests/journeys.json";
const FIRST_PAINT_KEY = "client/first-paint-work/year3/any";
const screensOf = (doc) =>
  doc?.entries?.[FIRST_PAINT_KEY]?.metrics ?? doc?.screens ?? null;
const queryBase = baseJson(queryFile);
const queryCurrent = currentJson(queryFile);
const currentScreens = screensOf(queryCurrent) ?? {};
const baseScreens = screensOf(queryBase);
if (baseScreens) {
  for (const [screen, budget] of Object.entries(currentScreens)) {
    const prior = baseScreens[screen];
    if (!prior) continue;
    for (const key of ["maxStatements", "maxHttpRequests"]) {
      if (Number(budget[key]) > Number(prior[key]) && !approved(queryCurrent))
        errors.push(
          `${queryFile}: ${screen}.${key} widened without approvedDeviation`
        );
    }
  }
  for (const screen of Object.keys(baseScreens))
    if (!Object.hasOwn(currentScreens, screen) && !approved(queryCurrent))
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

// #915 replaced tests/matrix.json with tests/claims.json: the 45-gate
// user-facing qualities panel retired into claim ROWS, each carrying its own
// severity and the date it was last demonstrated red. The governed payload is
// those rows — remove a claim, restate what a gate proves, or move the date it
// was last shown to go red, and this fingerprint moves with it.
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
