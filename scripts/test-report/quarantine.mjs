#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const QUARANTINE_PATH = path.join(root, "tests/quarantine.json");

export function parseDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value))
    return null;
  const at = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(at) ? at : null;
}

export function validateQuarantine(document, nowMs) {
  const errors = [];
  if (!document || typeof document !== "object")
    return { errors: ["quarantine: file is not an object"], entries: [] };
  const doc = /** @type {Record<string, unknown>} */ (document);
  const entries = Array.isArray(doc.entries) ? doc.entries : null;
  if (!entries)
    return { errors: ["quarantine: `entries` must be an array"], entries: [] };

  const policy = /** @type {Record<string, unknown>} */ (doc._policy ?? {});
  const maxDays = Number(policy.maxDays);
  const budget = Number(policy.budget);
  if (!Number.isInteger(maxDays) || maxDays <= 0)
    errors.push("quarantine: `_policy.maxDays` must be a positive integer");
  if (!Number.isInteger(budget) || budget < 0)
    errors.push("quarantine: `_policy.budget` must be a non-negative integer");

  const seen = new Set();
  for (const [index, raw] of entries.entries()) {
    const entry = /** @type {Record<string, unknown>} */ (raw ?? {});
    const where = `quarantine[${index}]`;
    const owner = typeof entry.owner === "string" ? entry.owner : "";
    if (!owner) errors.push(`${where}: needs an \`owner\` test file path`);
    if (owner && seen.has(owner))
      errors.push(`${where}: ${owner} is quarantined twice`);
    seen.add(owner);
    if (!Number.isInteger(entry.issue) || Number(entry.issue) <= 0)
      errors.push(
        `${where}: ${owner || "entry"} needs \`issue\` — a real GitHub issue number, so the flake is owned by someone`
      );
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 12)
      errors.push(
        `${where}: ${owner || "entry"} needs a \`reason\` describing HOW it flakes; "flaky" is not a reason`
      );
    const from = parseDay(entry.quarantinedAt);
    const until = parseDay(entry.expiresAt);
    if (from === null)
      errors.push(`${where}: \`quarantinedAt\` must be YYYY-MM-DD`);
    if (until === null)
      errors.push(`${where}: \`expiresAt\` must be YYYY-MM-DD`);
    if (from !== null && until !== null) {
      if (until <= from)
        errors.push(`${where}: \`expiresAt\` must be after \`quarantinedAt\``);
      else if (Number.isInteger(maxDays) && until - from > maxDays * 86_400_000)
        errors.push(
          `${where}: ${owner} is quarantined for longer than the ${maxDays}-day policy`
        );
      if (until <= nowMs)
        errors.push(
          `${where}: ${owner} EXPIRED on ${entry.expiresAt} — fix it and return it to the lane, or delete it with a receipt (#${entry.issue})`
        );
    }
  }

  if (Number.isInteger(budget) && entries.length > budget)
    errors.push(
      `quarantine: ${entries.length} entries exceeds the budget of ${budget} — the budget is down-only, so raising it needs an explicit, reviewed edit`
    );
  else if (Number.isInteger(budget) && entries.length < budget)
    errors.push(
      `quarantine: only ${entries.length} entries remain — ratchet \`_policy.budget\` down to ${entries.length}`
    );

  return { errors, entries };
}

export function readQuarantine(file = QUARANTINE_PATH) {
  return JSON.parse(readFileSync(file, "utf8"));
}

if (process.argv[1] === import.meta.filename) {
  const document = readQuarantine();
  const { errors, entries } = validateQuarantine(document, Date.now());
  if (process.argv.includes("--exclude")) {
    process.stdout.write(
      entries.map((entry) => String(entry.owner)).join("\n") +
        (entries.length ? "\n" : "")
    );
    process.exit(0);
  }
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ errors, entries }, null, 2)}\n`);
    process.exit(errors.length ? 1 : 0);
  }
  for (const error of errors) console.error(error);
  if (errors.length) {
    console.error(`quarantine: ${errors.length} violation(s)`);
    process.exit(1);
  }
  console.log(
    `quarantine: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}, none expired (budget ${document._policy?.budget})`
  );
}
