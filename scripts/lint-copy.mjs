#!/usr/bin/env node
// Copy ratchet gate (DESIGN.md "## Copy").
//
// Every member-facing string lives in `copy/<app>.json` under `strings`. The
// Copy section's budgets and bans are only as good as the next hand that
// writes a string, so this gate makes the countable half of them mechanical.
// Each rule id names the ruling it enforces:
//
//   copy-banned-word
//       "Banned everywhere: please, successfully, simply, in order to, you
//       can, we're sorry", plus the internals jargon the vocabulary table
//       retires: seal/sealed/unseal, receipt, ledger, drain, derived,
//       "in memory", "at rest", "by design", `core.*`, photograph,
//       "this device", "gateway" and "24 words". "gateway" survives only
//       inside a quoted `centraid-gateway` command; "24 words" only where
//       the member types the recovery key (a key named *WORD*, *TYPE*,
//       *ENTER* or *COUNT*, or a value that names the "recovery key").
//   copy-dot-join
//       "No ` · ` joining two thoughts in one string." The dot survives
//       between short metadata facts, so a value of six words or fewer is
//       exempt.
//   copy-over-budget
//       The hard caps, by key suffix: actions and labels 4 words, notes,
//       details, ledes, statuses and hints 12, bodies, leads, notices and
//       errors 25, titles 6. The caps are ceilings, not targets: DESIGN.md
//       "Copy" budgets are tighter, and the lane that writes a string
//       writes to those.
//
// A string counts once per rule, however many times it offends. The scan
// reads `strings` only; `$comment`, `functions`, `routes`, `moreRoutes` and
// `shelves` are metadata, not copy.
//
// BUDGET. Like lint-native-controls.mjs this is a ratchet, not a judgment
// call at commit time: BUDGET maps `rule -> { file: count }` with today's
// measured counts and only shrinks. A file over its budget, or a file with
// no entry that now counts, fails. A file UNDER its budget also fails — the
// budget must be lowered in the same change, so the debt can never creep
// back into the headroom a rewrite opened up. Never raise a number: cut the
// words, or open a DESIGN.md argument.
//
// Run with `--print` to emit the measured budget as JSON, the sanctioned way
// to record a decrease. Run with `--list` to name every offending key.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const COPY_DIR = "copy";

/** Words are whitespace tokens that carry a letter or digit, so a dash or a
 *  dot between phrases is not a word and `{name}` is exactly one. */
export function wordCount(value) {
  return value.split(/\s+/u).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
}

const BANNED = [
  { name: "please", re: /\bplease\b/iu },
  { name: "successfully", re: /\bsuccessfully\b/iu },
  { name: "simply", re: /\bsimply\b/iu },
  { name: "in order to", re: /\bin order to\b/iu },
  { name: "you can", re: /\byou can\b(?!['’]t)/iu },
  { name: "we're sorry", re: /\bwe['’]re sorry\b/iu },
  { name: "seal", re: /\b(?:un)?seal(?:s|ed|ing)?\b/iu },
  { name: "receipt", re: /\breceipts?\b/iu },
  { name: "ledger", re: /\bledgers?\b/iu },
  { name: "drain", re: /\bdrain(?:s|ed|ing)?\b/iu },
  { name: "derived", re: /\bderived\b/iu },
  { name: "in memory", re: /\bin memory\b/iu },
  { name: "at rest", re: /\bat rest\b/iu },
  { name: "by design", re: /\bby design\b/iu },
  { name: "core.", re: /\bcore\.[a-z_]/iu },
  { name: "photograph", re: /\bphotographs?\b/iu },
  { name: "this device", re: /\bthis device\b/iu },
];

/** A quoted run that holds a `centraid-gateway` command: the one home of the
 *  word "gateway", because the command is a literal the member types. */
const GATEWAY_COMMAND = /[“"`‘'][^”"`’']*centraid-gateway[^”"`’']*[”"`’']/giu;
const GATEWAY = /\bgateways?\b/iu;
const TWENTY_FOUR_WORDS = /\b24 words\b/iu;
const WORDS_KEY = /WORD|TYPE|ENTER|COUNT/u;

/** Banned terms found in one value, by name. */
export function bannedIn(key, value) {
  const hits = BANNED.filter(({ re }) => re.test(value)).map((b) => b.name);
  if (GATEWAY.test(value.replace(GATEWAY_COMMAND, " "))) hits.push("gateway");
  if (
    TWENTY_FOUR_WORDS.test(value) &&
    !WORDS_KEY.test(key) &&
    !/\brecovery key\b/iu.test(value)
  ) {
    hits.push("24 words");
  }
  return hits;
}

/** Word caps by key suffix, first match wins. */
export const CAPS = [
  {
    kind: "action",
    max: 4,
    re: /(?:^|_)(?:LABEL|ACTION|PRIMARY|SECONDARY|BUTTON|COMMIT|VERB)$/u,
  },
  { kind: "note", max: 12, re: /(?:^|_)(?:NOTE|DETAIL|LEDE|STATUS|HINT)$/u },
  { kind: "body", max: 25, re: /(?:^|_)(?:BODY|LEAD|NOTICE)$/u },
  { kind: "error", max: 25, re: /(?:^|_)(?:FAILED|ERROR|REFUSED|DENIED)$/u },
  { kind: "title", max: 6, re: /(?:^|_)(?:TITLE|HEADLINE)$/u },
];

export function capFor(key) {
  return CAPS.find((c) => c.re.test(key)) ?? null;
}

/** Findings for one string: `[{ rule, detail }]`. */
export function lintString(key, value) {
  const findings = [];
  const banned = bannedIn(key, value);
  if (banned.length > 0) {
    findings.push({ rule: "copy-banned-word", detail: banned.join(", ") });
  }
  const words = wordCount(value);
  if (value.includes(" · ") && words > 6) {
    findings.push({ rule: "copy-dot-join", detail: `${words} words` });
  }
  const cap = capFor(key);
  if (cap && words > cap.max) {
    findings.push({
      rule: "copy-over-budget",
      detail: `${words} words, ${cap.kind} cap ${cap.max}`,
    });
  }
  return findings;
}

/** Findings for a `strings` table: `[{ key, rule, detail }]`. */
export function scanStrings(strings) {
  const out = [];
  for (const [key, value] of Object.entries(strings ?? {})) {
    if (typeof value !== "string") continue;
    for (const f of lintString(key, value)) out.push({ key, ...f });
  }
  return out;
}

/** Measure the tree: `{ rule: { "copy/x.json": count } }` plus the findings. */
export function measure(root = ROOT) {
  const dir = path.resolve(root, COPY_DIR);
  const measured = {};
  const findings = [];
  const missing = [];
  if (!existsSync(dir)) return { measured, findings, missing: [COPY_DIR] };
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const rel = `${COPY_DIR}/${name}`;
    const doc = JSON.parse(readFileSync(path.resolve(dir, name), "utf8"));
    for (const f of scanStrings(doc.strings)) {
      (measured[f.rule] ??= {})[rel] = (measured[f.rule][rel] ?? 0) + 1;
      findings.push({ file: rel, ...f });
    }
  }
  return { measured, findings, missing };
}

// Shrink-only. Each entry is a debt taken on knowingly, with the reason beside
// it; a new one needs the same.
const BUDGET = {
  "copy-banned-word": {
    // RECEIPT_NONE, RECEIPT_SHOT_ALT: an expense's paper receipt, a real thing
    // the member photographs — not Locker's access log.
    "copy/tally.json": 2,
  },
  "copy-dot-join": {
    // IN_TRASH_LAPSED, IMPORT_COUNTS, STATUS_ROSTER_SHOWN: short metadata
    // facts and counts, the one sanctioned use of " · ".
    "copy/docs.json": 1,
    "copy/locker.json": 1,
    "copy/people.json": 1,
  },
  "copy-over-budget": {
    // EXPORT_LEDE: the plaintext-export warning, a security disclosure, which
    // keeps a full sentence (DESIGN.md "Copy").
    "copy/locker.json": 1,
    // PHOTOS_KEEP_ORIGINALS_LABEL, OWN_LABEL: toggle and checkbox labels, and
    // ENDPOINT_LABEL, RESTORE_HELD_OWN_LABEL: field and list prompts — the
    // `_LABEL` suffix also names these, and they are not buttons.
    "copy/photos.json": 1,
    "copy/words.json": 3,
  },
};

/** Compare measured counts to the budget. Returns three lists. */
export function compareBudget(measured, budget) {
  const over = [];
  const under = [];
  const rules = new Set([...Object.keys(measured), ...Object.keys(budget)]);
  for (const rule of [...rules].sort()) {
    const have = measured[rule] ?? {};
    const allowed = budget[rule] ?? {};
    const files = new Set([...Object.keys(have), ...Object.keys(allowed)]);
    for (const file of [...files].sort()) {
      const n = have[file] ?? 0;
      const b = allowed[file] ?? 0;
      if (n > b) over.push({ rule, file, count: n, budget: b });
      else if (n < b) under.push({ rule, file, count: n, budget: b });
    }
  }
  return { over, under };
}

/** Per-rule totals of a `rule -> { file: count }` map. */
export function totals(map) {
  return Object.fromEntries(
    Object.entries(map).map(([rule, files]) => [
      rule,
      Object.values(files).reduce((a, b) => a + b, 0),
    ])
  );
}

function sortedBudget(measured) {
  const out = {};
  for (const rule of Object.keys(measured).sort()) {
    out[rule] = Object.fromEntries(
      Object.entries(measured[rule]).sort(([a], [b]) => a.localeCompare(b))
    );
  }
  return out;
}

export function lintCopy(root = ROOT, budget = BUDGET) {
  const { measured, findings, missing } = measure(root);
  return { missing, measured, findings, ...compareBudget(measured, budget) };
}

function main() {
  if (process.argv.includes("--print")) {
    const { measured, missing } = measure();
    if (missing.length > 0) {
      console.error(`FAIL — target does not exist: ${missing.join(", ")}`);
      process.exit(1);
    }
    console.log(JSON.stringify(sortedBudget(measured), null, 2));
    return;
  }

  const { missing, measured, findings, over, under } = lintCopy();
  if (missing.length > 0) {
    console.error(
      `FAIL — target does not exist: ${missing.join(", ")}. Targets are stale in scripts/lint-copy.mjs.`
    );
    process.exit(1);
  }

  if (process.argv.includes("--list")) {
    for (const f of findings) {
      console.log(`${f.rule}  ${f.file}  ${f.key}: ${f.detail}`);
    }
    return;
  }

  if (over.length > 0) {
    console.error("\nFAIL — copy exceeds its budget:\n");
    for (const o of over) {
      console.error(`  ${o.rule}  ${o.file}: ${o.count} (budget ${o.budget})`);
    }
    console.error(
      '\nDESIGN.md "Copy": cut the words, use the vocabulary table, keep reassurance\n' +
        "to consent, destructive confirms and security disclosures. Do not raise the\n" +
        "budget. Run `node scripts/lint-copy.mjs --list` to name the offending keys.\n"
    );
  }
  if (under.length > 0) {
    console.error(
      "\nFAIL — ratchet down: the measured count is below budget:\n"
    );
    for (const u of under) {
      console.error(
        `  ${u.rule}  ${u.file}: ${u.count} (budget ${u.budget}) — lower the BUDGET entry to ${u.count}${u.count === 0 ? " (delete it)" : ""} in scripts/lint-copy.mjs`
      );
    }
    console.error(
      "\nThe budget only shrinks, and it shrinks in the same change that fixes the debt.\n"
    );
  }
  if (over.length > 0 || under.length > 0) process.exit(1);

  const t = totals(measured);
  console.log(
    `ok   copy at budget: ${
      Object.entries(t)
        .sort()
        .map(([r, n]) => `${r}=${n}`)
        .join(" ") || "no debt"
    }`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
