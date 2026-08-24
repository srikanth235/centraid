/*
 * Diagnostics redaction engine (#842 W8.1).
 *
 * The sovereign-vault promise is that vault bytes stay on the owner's
 * machine. A support bundle is the one artifact designed to LEAVE it, by
 * explicit owner action, so it is the single place where that promise can
 * be broken by accident. This module is the mechanism that keeps it.
 *
 * The model is **allowlist by construction, denylist as belt-and-braces**:
 *
 *  1. `support-bundle.ts` never copies an arbitrary object into the
 *     document. Every field it emits is emitted through a declared
 *     `LeafPolicy` (below), so a value whose shape the policy does not
 *     recognise is replaced rather than passed through. A new field added
 *     to an upstream structure cannot ride along silently, because nothing
 *     copies structures — the builder names each field.
 *  2. Free text (log lines, error messages, health details) is the one
 *     lane where owner data can be interpolated by code this module does
 *     not control. It goes through `scrubProse`, an ordered rule battery
 *     that removes key blocks, JWTs, emails, URLs, absolute paths, IPs,
 *     phone numbers, payment cards, every quoted run (this codebase quotes
 *     interpolated owner values — `vault registry: created vault v-x
 *     ("My Vault")`), high-entropy runs, overlong tokens, and finally any
 *     SENTENCE-length word run, which is the only handle a pattern has on
 *     owner prose interpolated unquoted into a message. What survives is
 *     the message SKELETON, which is the diagnostic part, not the data
 *     part.
 *  3. `scrubProse` still cannot catch a short, low-entropy, unquoted value
 *     interpolated into a log line (`hunter2`). No pattern can. That is
 *     why the shareable bundle defaults to `strict`, which drops prose
 *     entirely and keeps level + component + a message DIGEST instead —
 *     support can ask the owner to grep their own local log for the
 *     digest. `standard` keeps the scrubbed skeleton and is opt-in.
 *  4. `applyTripwire` is the last gate: the serialized document is swept
 *     for literal values the caller knows are sensitive (seal-key
 *     material, bearer tokens, owner-authored vault names, configured
 *     secret values). A hit is redacted AND counted, so a leak that the
 *     policy missed shows up in the bundle's own `redaction` report
 *     instead of shipping silently.
 *
 * Determinism: no clock and no randomness live here. Identifier hashing is
 * salted by a caller-supplied string so ids correlate WITHIN one bundle
 * without the raw id leaving the device, and two runs over the same input
 * with the same salt produce byte-identical output.
 */

import { createHash } from "node:crypto";

export const REDACTION_LEVELS = ["strict", "standard"] as const;
export type RedactionLevel = (typeof REDACTION_LEVELS)[number];

/** Every rule that can replace a value. Reported per-bundle by count. */
export const REDACTION_RULE_IDS = [
  "private-key-block",
  "jwt",
  "email",
  "url",
  "absolute-path",
  "ip-address",
  "phone",
  "payment-card",
  "quoted-value",
  "high-entropy",
  "long-token",
  "sentence-run",
  "length-cap",
  "secret-key",
  "shape-refused",
  "prose-dropped",
  "depth-cap",
  "width-cap",
  "tripwire",
] as const;
export type RedactionRuleId = (typeof REDACTION_RULE_IDS)[number];

export interface RedactionReport {
  level: RedactionLevel;
  /** Rule id -> number of values it replaced. Zero-filled, never sparse. */
  byRule: Record<RedactionRuleId, number>;
  /** Leaf values considered. */
  leaves: number;
  /** Leaf values replaced by at least one rule. */
  redactedLeaves: number;
}

export function emptyRedactionReport(level: RedactionLevel): RedactionReport {
  const byRule = {} as Record<RedactionRuleId, number>;
  for (const id of REDACTION_RULE_IDS) byRule[id] = 0;
  return { level, byRule, leaves: 0, redactedLeaves: 0 };
}

function hit(report: RedactionReport, rule: RedactionRuleId, count = 1): void {
  report.byRule[rule] += count;
}

const MARK = (rule: RedactionRuleId): string => `[REDACTED:${rule}]`;

/** Prose cap. Long enough for a real log skeleton, short enough that a
 *  runaway interpolation cannot smuggle a document out inside one line. */
export const PROSE_MAX_CHARS = 240;
/** Depth/width caps for the unknown-config walk. */
const MAX_DEPTH = 8;
const MAX_ARRAY = 64;
const MAX_KEYS = 128;

/** Key names that mark a value secret-shaped, matched case-insensitively at
 *  any depth. Deliberately broad and naming-convention based: a false
 *  positive redacts a harmless field, a false negative mails a credential
 *  to a stranger. One key-name filter covers both the diagnostics endpoint
 *  and the shareable support bundle (#846 P8). */
export const SECRET_KEY_PATTERN =
  /token|secret|password|passwd|passphrase|credential|api[-_]?key|private[-_]?key|seal[-_]?key|bearer|authorization|cookie|mnemonic|otp|seed|cvv|\bpin\b|signature|session[-_]?id/iu;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = digits.charCodeAt(index) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

interface ProseRule {
  readonly id: RedactionRuleId;
  readonly pattern: RegExp;
  readonly replace?: (match: string) => string;
}

/*
 * Order is load-bearing: specific, high-signal shapes run first so their
 * replacement text survives into the skeleton, and the blunt catch-alls
 * (`quoted-value`, `high-entropy`, `long-token`) run last over whatever is
 * left. Every pattern is global + unicode; none is anchored, because these
 * run against arbitrary interpolated text.
 */
const PROSE_RULES: readonly ProseRule[] = [
  {
    id: "private-key-block",
    pattern:
      /-{5}BEGIN[A-Z ]*PRIVATE KEY-{5}[\s\S]*?-{5}END[A-Z ]*PRIVATE KEY-{5}/gu,
  },
  {
    id: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]+)?/gu,
  },
  { id: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu },
  {
    id: "url",
    // Keep the scheme so "it failed talking to an https endpoint" survives;
    // host, path, query and fragment all go.
    pattern: /\b(?<scheme>[A-Za-z][A-Za-z0-9+.-]*):\/\/[^\s"'`<>]+/gu,
    replace: (match) =>
      `${match.slice(0, match.indexOf(":"))}://[REDACTED:url]`,
  },
  {
    id: "absolute-path",
    // POSIX (/Users/priya/…) and Windows (C:\Users\priya\…). Two or more
    // segments only, so a bare "/" or a lone route token is left alone.
    pattern: /(?:[A-Za-z]:[\\/]|\/)(?:[\w %.~+-]+[\\/])+[\w %.~+-]*/gu,
  },
  {
    id: "ip-address",
    pattern:
      /\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b/gu,
  },
  // Payment cards run BEFORE phones: both shapes are long digit runs with
  // separators, so whichever runs first wins the attribution. The specific
  // rule should own the value it recognises; a Luhn-invalid run falls
  // through to `phone`, which redacts it anyway.
  {
    id: "payment-card",
    pattern: /\b(?:\d[ -]?){12,18}\d\b/gu,
    replace: (match) =>
      luhnValid(match.replaceAll(/[^\d]/gu, "")) ? MARK("payment-card") : match,
  },
  // Lookarounds, not `\b`: without them a digit run INSIDE a longer
  // alphanumeric handle matches and the replacement splits that handle into
  // two surviving halves — which the W8.1 canary caught this rule doing to a
  // 32-character hex blob id.
  {
    id: "phone",
    pattern: /(?<![A-Za-z0-9])\+?\d[\d ()-]{8,}\d(?![A-Za-z0-9])/gu,
  },
  {
    id: "quoted-value",
    // This codebase interpolates owner-authored values inside quotes.
    pattern: /"[^"\n]{1,4096}"|'[^'\n]{1,4096}'|`[^`\n]{1,4096}`/gu,
  },
  { id: "high-entropy", pattern: /[A-Za-z0-9+/=_-]{24,}/gu },
  { id: "long-token", pattern: /\S{64,}/gu },
  // The catch-all for the class no shape rule can recognise: owner PROSE
  // interpolated unquoted into a log line ("notes: body too large — <the
  // whole note>"). A log skeleton is a handful of words around structured
  // values; a run of this many consecutive words is a sentence somebody
  // wrote. It runs last so the structured rules keep their attribution.
  // This rule is why `standard` is defensible at all — and why `strict`,
  // which drops prose outright, is still the default.
  {
    id: "sentence-run",
    pattern: /[\p{L}\p{N}'’]+(?:[ \t]+[\p{L}\p{N}'’]+){7,}/gu,
  },
];

/*
 * `payment-card` returns the match unchanged when Luhn refuses, so a
 * per-rule "did it fire" count cannot be taken from `match().length`.
 * Every rule therefore reports through this one path.
 */
function applyRule(
  text: string,
  rule: ProseRule,
  report: RedactionReport
): string {
  let fired = 0;
  const next = text.replaceAll(rule.pattern, (match) => {
    const replacement = rule.replace ? rule.replace(match) : MARK(rule.id);
    if (replacement !== match) fired += 1;
    return replacement;
  });
  if (fired > 0) hit(report, rule.id, fired);
  return next;
}

/**
 * Reduce free text to its diagnostic skeleton. Returns the scrubbed string;
 * `report` accumulates which rules fired. Idempotent in the sense that
 * re-scrubbing a scrubbed string cannot re-expand it — the `[REDACTED:x]`
 * marks are short, unquoted and low-entropy, so no rule matches them.
 */
export function scrubProse(text: string, report: RedactionReport): string {
  let out = text;
  for (const rule of PROSE_RULES) out = applyRule(out, rule, report);
  if (out.length > PROSE_MAX_CHARS) {
    out = `${out.slice(0, PROSE_MAX_CHARS)}…${MARK("length-cap")}`;
    hit(report, "length-cap");
  }
  return out;
}

/** 12 hex of sha256 — a stable handle for a value whose plaintext never
 *  leaves the device. Support quotes the digest; the owner greps their own
 *  local log for the matching line. */
export function digest12(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/** Salted, truncated hash of an identifier. Correlates rows WITHIN one
 *  bundle (same salt) while carrying no cross-bundle linkability and no
 *  recoverable original. */
export function hashIdentifier(value: string, salt: string): string {
  return `id:${createHash("sha256").update(`${salt}\u0000${value}`).digest("hex").slice(0, 12)}`;
}

export type LeafPolicy =
  /** Never emitted. */
  | "drop"
  /** Free text: scrubbed at `standard`, dropped entirely at `strict`. */
  | "prose"
  /** Low-cardinality machine token produced by our own code. */
  | "enum"
  /** Finite number. */
  | "number"
  /** ISO-8601 instant. */
  | "timestamp"
  /** Owner-scoped id, emitted as a salted hash. */
  | "identifier"
  /** Constant this repo authored (version strings, platform names). */
  | "verbatim";

// `@` is allowed so a stack fingerprint (`fn@file.js:12`) is an enum leaf
// rather than a refused one; it carries no more information than the parts.
const ENUM_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/u;
const TIMESTAMP_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u;
const VERBATIM_SHAPE = /^[\w .+:/@-]{0,64}$/u;

export interface LeafContext {
  readonly report: RedactionReport;
  /** Salt for `identifier` hashing — one per bundle. */
  readonly salt: string;
}

/**
 * Emit one leaf under a declared policy. A value that fails its policy's
 * shape is refused (`shape-refused`), never passed through — that is the
 * property that makes the bundle allowlist-shaped rather than best-effort.
 */
export function emitLeaf(
  value: unknown,
  policy: LeafPolicy,
  context: LeafContext
): string | number | null {
  const { report } = context;
  report.leaves += 1;
  const refuse = (rule: RedactionRuleId): string => {
    hit(report, rule);
    report.redactedLeaves += 1;
    return MARK(rule);
  };
  switch (policy) {
    case "drop":
      return refuse("shape-refused");
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? value
        : refuse("shape-refused");
    case "prose": {
      if (typeof value !== "string") return refuse("shape-refused");
      if (report.level === "strict") {
        hit(report, "prose-dropped");
        report.redactedLeaves += 1;
        return MARK("prose-dropped");
      }
      const before = report.redactedLeaves;
      const scrubbed = scrubProse(value, report);
      if (scrubbed !== value) report.redactedLeaves = before + 1;
      return scrubbed;
    }
    case "enum":
      return typeof value === "string" && ENUM_SHAPE.test(value)
        ? value
        : refuse("shape-refused");
    case "timestamp":
      return typeof value === "string" && TIMESTAMP_SHAPE.test(value)
        ? value
        : refuse("shape-refused");
    case "identifier":
      return typeof value === "string" && value.length > 0
        ? hashIdentifier(value, context.salt)
        : refuse("shape-refused");
    case "verbatim":
      return typeof value === "string" && VERBATIM_SHAPE.test(value)
        ? value
        : refuse("shape-refused");
    default:
      return refuse("shape-refused");
  }
}

/**
 * A config VALUE that reads as a machine setting rather than as text:
 * lowercase, no whitespace, no apostrophes, short. `s3`, `darwin`,
 * `local-gateway`, `v2` pass; `Priya`, `Priya's vault`, `Backup of 2024`
 * and any high-entropy run do not.
 *
 * This is the one deliberate relaxation in the walk below, and it exists
 * because without it a `strict` bundle reports every setting as
 * `[REDACTED]` — which is a blank page, not a safe bundle. The residual
 * risk it accepts is a short lowercase SECRET stored under a key whose
 * name is not secret-shaped (`dbpass` is caught; `foo: "hunter2"` is not).
 * Two things cover that: `SECRET_KEY_PATTERN` catches the naming
 * conventions actually in use, and the caller passes known credential
 * values to `applyTripwire`, which sweeps them out of the serialized
 * document by literal. It is stated in the bundle's own disclosure list
 * rather than left as an unwritten assumption.
 */
const MACHINE_TOKEN = /^[a-z0-9][a-z0-9._:+-]{0,15}$/u;
/** A long hex/base32 run is a handle or a key, never a setting name. */
const OPAQUE_HANDLE = /^[0-9a-f]{12,}$/u;

function isMachineSetting(value: string): boolean {
  return MACHINE_TOKEN.test(value) && !OPAQUE_HANDLE.test(value);
}

/**
 * Walk a caller-assembled config/runtime summary whose shape we do not
 * control. Secret-shaped keys are dropped by name; machine-token values
 * survive; other strings are prose-scrubbed (or dropped at `strict`);
 * numbers and booleans survive; depth and width are capped so a surprise
 * structure cannot balloon the bundle. Cycles are not a concern — callers
 * pass plain data, and the depth cap terminates anyway.
 */
export function scrubUnknown(
  value: unknown,
  context: LeafContext,
  depth = 0
): unknown {
  const { report } = context;
  if (depth > MAX_DEPTH) {
    hit(report, "depth-cap");
    return MARK("depth-cap");
  }
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") {
    report.leaves += 1;
    return value;
  }
  if (typeof value === "number") return emitLeaf(value, "number", context);
  if (typeof value === "string")
    return emitLeaf(value, isMachineSetting(value) ? "enum" : "prose", context);
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ARRAY);
    if (value.length > kept.length) hit(report, "width-cap");
    return kept.map((entry) => scrubUnknown(entry, context, depth + 1));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const kept = entries.slice(0, MAX_KEYS);
    if (entries.length > kept.length) hit(report, "width-cap");
    const out: Record<string, unknown> = {};
    for (const [key, entry] of kept) {
      if (SECRET_KEY_PATTERN.test(key)) {
        report.leaves += 1;
        report.redactedLeaves += 1;
        hit(report, "secret-key");
        out[key] = MARK("secret-key");
        continue;
      }
      out[key] = scrubUnknown(entry, context, depth + 1);
    }
    return out;
  }
  report.leaves += 1;
  report.redactedLeaves += 1;
  hit(report, "shape-refused");
  return MARK("shape-refused");
}

export interface TripwireResult {
  readonly text: string;
  readonly hits: number;
}

/**
 * Last gate before the document is handed to the owner. Sweeps the
 * serialized bundle for literal values the caller knows are sensitive and
 * replaces every occurrence. A hit means the policy above missed
 * something: the value is still removed, and the count rides in the
 * bundle's own `redaction` report so the miss is visible rather than
 * silent. Values shorter than 4 characters are ignored — they would match
 * inside unrelated tokens and turn the document into confetti.
 */
export function applyTripwire(
  text: string,
  forbidden: Iterable<string>,
  report?: RedactionReport
): TripwireResult {
  let out = text;
  let hits = 0;
  for (const raw of forbidden) {
    if (typeof raw !== "string" || raw.length < 4) continue;
    let index = out.indexOf(raw);
    while (index !== -1) {
      hits += 1;
      out =
        out.slice(0, index) + MARK("tripwire") + out.slice(index + raw.length);
      index = out.indexOf(raw, index + 1);
    }
  }
  if (report && hits > 0) hit(report, "tripwire", hits);
  return { text: out, hits };
}
