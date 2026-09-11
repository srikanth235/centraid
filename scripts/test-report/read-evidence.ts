/**
 * The evidence reader (#915 Wave 3, contract C2).
 *
 * The nightly downloads every lane's artifact into one flat directory. This
 * module turns that directory into a map from lane id to evidence, and — the
 * point of it — turns every unreadable, unparseable or invalid file into an
 * error string the report prints. A file that cannot be read is the loudest
 * possible signal that a lane's wiring broke, so it is never dropped.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { validateEvidence } from "./evidence-schema.ts";
import {
  dict,
  errorMessage,
  fromAsync,
  has,
  isRecord,
  items,
  type Loose,
} from "./record.ts";

/**
 * Read a directory of `<lane>.json` evidence files.
 * @param {string} dir absolute or cwd-relative path to the evidence directory
 * @param {{readdir?: Function, readFile?: Function}} [io] injected for tests
 * @returns {{lanes: Map<string, Loose>, errors: string[]}} the lanes that parsed, and one error string per file that did not
 */
export function readEvidenceDir(
  dir: string,
  io:
    | {
        readdir?: (target: string) => unknown[];
        readFile?: (target: string) => string;
      }
    | undefined = {}
): { lanes: Map<string, Loose>; errors: string[] } {
  const readdir = io.readdir ?? ((target: string) => readdirSync(target));
  const readFile =
    io.readFile ?? ((target: string) => readFileSync(target, "utf8"));

  const lanes: Map<string, Loose> = new Map();
  const errors: string[] = [];

  let entries;
  try {
    entries = readdir(dir)
      .filter((name) => String(name).endsWith(".json"))
      .sort();
  } catch {
    // An absent directory is not an error here: a rung that produced no lanes
    // at all is rendered as no-evidence by the model, with the claims file
    // saying which lanes were expected.
    return { lanes, errors };
  }

  for (const name of entries) {
    const file = path.join(dir, String(name));
    let parsed;
    try {
      parsed = JSON.parse(readFile(file));
    } catch (error: unknown) {
      errors.push(`${name}: not readable as JSON (${errorMessage(error)})`);
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

/**
 * The age of the freshest evidence file, in milliseconds, or null when the
 * directory holds none. Used by the masthead's "evidence 2h 14m old".
 * @param {string} dir absolute or cwd-relative path to the evidence directory
 * @param {Date} now the instant to measure the age against
 */
export function evidenceAgeMs(dir: string, now: Date = new Date()) {
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
