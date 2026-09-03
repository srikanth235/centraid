import { readFileSync } from "node:fs";
import path from "node:path";

import { PLATFORMS, RUNGS } from "./evidence-schema.mjs";

export const CLAIMS_SCHEMA_VERSION = 1;

export const SEVERITIES = Object.freeze(["S1", "S2", "S3", "S4"]);

export const LANE_STATUSES = Object.freeze(["gating", "advisory"]);

const ID = /^[a-z0-9][a-z0-9._-]*$/u;

function vocabularyErrors(vocabulary, push) {
  if (!vocabulary || typeof vocabulary !== "object") {
    push("vocabulary must be an object with qualities[] and surfaces[]");
    return { qualities: new Set(), surfaces: new Set() };
  }
  const seen = { qualities: new Set(), surfaces: new Set() };
  for (const key of ["qualities", "surfaces"]) {
    const list = vocabulary[key];
    if (!Array.isArray(list) || list.length === 0) {
      push(`vocabulary.${key} must be a non-empty array`);
      continue;
    }
    for (const entry of list) {
      if (!entry || !ID.test(String(entry.id ?? ""))) {
        push(`vocabulary.${key} entry needs a lower-case id`);
        continue;
      }
      if (seen[key].has(entry.id))
        push(`vocabulary.${key} repeats "${entry.id}"`);
      seen[key].add(entry.id);
      if (typeof entry.label !== "string" || entry.label === "") {
        push(`vocabulary.${key}.${entry.id} needs a label`);
      }
    }
  }
  return seen;
}

function laneErrors(lanes, vocab, push) {
  if (!Array.isArray(lanes)) {
    push("lanes must be an array");
    return;
  }
  const seen = new Set();
  for (const lane of lanes) {
    const id = String(lane?.id ?? "");
    if (!ID.test(id)) {
      push(`lanes entry ${JSON.stringify(lane?.id)} is not a GitHub job id`);
      continue;
    }
    if (seen.has(id)) push(`lanes repeats "${id}"`);
    seen.add(id);
    if (!RUNGS.includes(lane.rung))
      push(`lanes.${id}.rung must be one of ${RUNGS.join("|")}`);
    if (!PLATFORMS.includes(lane.platform))
      push(`lanes.${id}.platform is not a known platform`);
    if (!(typeof lane.budgetMs === "number" && lane.budgetMs > 0)) {
      push(`lanes.${id}.budgetMs must be a positive number of milliseconds`);
    }
    if (!LANE_STATUSES.includes(lane.status)) {
      push(`lanes.${id}.status must be ${LANE_STATUSES.join(" or ")}`);
    }
    for (const [key, set] of [
      ["qualities", vocab.qualities],
      ["surfaces", vocab.surfaces],
    ]) {
      const tags = lane[key];
      if (!Array.isArray(tags)) {
        push(`lanes.${id}.${key} must be an array`);
        continue;
      }
      for (const tag of tags) {
        if (!set.has(tag))
          push(
            `lanes.${id}.${key} names "${tag}", which is not in the vocabulary`
          );
      }
    }
  }
}

function claimErrors(claims, push) {
  if (!Array.isArray(claims)) {
    push("claims must be an array");
    return;
  }
  const seen = new Set();
  for (const claim of claims) {
    const id = String(claim?.id ?? "");
    if (id === "") {
      push("a claim row has no id");
      continue;
    }
    if (seen.has(id)) push(`claims repeats "${id}"`);
    seen.add(id);
    if (!SEVERITIES.includes(claim.severity)) {
      push(`claims.${id}.severity must be one of ${SEVERITIES.join("|")}`);
    }
    if (typeof claim.owner !== "string" || claim.owner === "") {
      push(`claims.${id}.owner must name the file that owns the proof`);
    }
    const red = claim.demonstratedRed;
    if (!red || !/^\d{4}-\d{2}-\d{2}$/u.test(String(red.date ?? ""))) {
      push(
        `claims.${id}.demonstratedRed.date must be the day the gate was last shown to go red`
      );
    }
  }
}

function naErrors(naCells, push) {
  if (!naCells || typeof naCells !== "object" || Array.isArray(naCells)) {
    push("naCells must be an object keyed by cell id");
    return;
  }
  for (const [id, row] of Object.entries(naCells)) {
    if (!["impossibility", "prohibition"].includes(row?.kind)) {
      push(`naCells.${id}.kind must be "impossibility" or "prohibition"`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(row?.reviewed ?? ""))) {
      push(`naCells.${id}.reviewed must be the date the cell was last re-read`);
    }
    if (typeof row?.restated !== "string" || row.restated.length < 20) {
      push(
        `naCells.${id}.restated must state the reason at length, not as a fragment`
      );
    }
    if (row?.citation !== undefined && typeof row.citation !== "string") {
      push(`naCells.${id}.citation must be a string when present`);
    }
  }
}

export function validateClaims(claims) {
  const errors = [];
  const push = (message) => errors.push(message);

  if (!claims || typeof claims !== "object" || Array.isArray(claims)) {
    return { ok: false, errors: ["claims must be a JSON object"] };
  }
  if (claims.schema !== CLAIMS_SCHEMA_VERSION) {
    push(
      `schema must be ${CLAIMS_SCHEMA_VERSION} (got ${JSON.stringify(claims.schema)})`
    );
  }
  const vocab = vocabularyErrors(claims.vocabulary, push);
  laneErrors(claims.lanes, vocab, push);
  claimErrors(claims.claims, push);
  naErrors(claims.naCells, push);

  for (const key of [
    "laws",
    "consentLedger",
    "joinLaws",
    "flows",
    "revisitTriggers",
  ]) {
    if (claims[key] === undefined) push(`${key} is required`);
  }
  if (Array.isArray(claims.flows)) {
    for (const flow of claims.flows) {
      if (typeof flow?.owner !== "string" || flow.owner === "") {
        push(`flows.${flow?.id ?? "?"} must name an owner path`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export function loadClaims(file) {
  const root = path.resolve(import.meta.dirname, "../..");
  const target = file
    ? path.resolve(root, file)
    : path.join(root, "tests/claims.json");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(target, "utf8"));
  } catch (error) {
    return { claims: null, errors: [`${target}: ${error.message}`] };
  }
  const { errors } = validateClaims(parsed);
  return { claims: parsed, errors };
}
