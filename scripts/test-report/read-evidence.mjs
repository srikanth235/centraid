import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { validateEvidence } from "./evidence-schema.mjs";

export function readEvidenceDir(dir, io = {}) {
  const readdir = io.readdir ?? ((target) => readdirSync(target));
  const readFile = io.readFile ?? ((target) => readFileSync(target, "utf8"));

  const lanes = new Map();
  const errors = [];

  let entries;
  try {
    entries = readdir(dir)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    return { lanes, errors };
  }

  for (const name of entries) {
    const file = path.join(dir, name);
    let parsed;
    try {
      parsed = JSON.parse(readFile(file));
    } catch (error) {
      errors.push(`${name}: not readable as JSON (${error.message})`);
      continue;
    }
    const { ok, errors: problems } = validateEvidence(parsed);
    if (!ok) {
      errors.push(`${name}: ${problems.join("; ")}`);
      continue;
    }
    const expected = `${parsed.lane}.json`;
    if (name !== expected) {
      errors.push(
        `${name}: declares lane "${parsed.lane}" but should be named ${expected}`
      );
      continue;
    }
    if (lanes.has(parsed.lane)) {
      errors.push(`${name}: duplicate evidence for lane "${parsed.lane}"`);
      continue;
    }
    lanes.set(parsed.lane, parsed);
  }

  return { lanes, errors };
}

export function evidenceAgeMs(dir, now = new Date()) {
  let newest = null;
  let entries;
  try {
    entries = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return null;
  }
  for (const name of entries) {
    const stamp = statSync(path.join(dir, name)).mtimeMs;
    if (newest === null || stamp > newest) newest = stamp;
  }
  return newest === null ? null : Math.max(0, now.getTime() - newest);
}
