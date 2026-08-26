/*
 * Diagnostics redaction (#842): allowlist by construction, denylist as
 * belt-and-braces. Every field is emitted through a declared `LeafPolicy`, so
 * an unrecognised shape is replaced and a new upstream field cannot ride
 * along. `scrubProse` reduces free text — the one uncontrolled lane — to a
 * message SKELETON; since no pattern catches a short unquoted value, `strict`
 * (prose dropped) is the shareable default. No clock, no randomness.
 */

import { createHash } from "node:crypto";

export const REDACTION_LEVELS = ["strict", "standard"] as const;
export type RedactionLevel = (typeof REDACTION_LEVELS)[number];

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
  /** Zero-filled, never sparse. */
  byRule: Record<RedactionRuleId, number>;
  leaves: number;
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

/** Short enough that a runaway interpolation cannot smuggle out a document. */
export const PROSE_MAX_CHARS = 240;
const MAX_DEPTH = 8;
const MAX_ARRAY = 64;
const MAX_KEYS = 128;

/** Deliberately broad: a false positive redacts a harmless field, a false
 *  negative mails a credential to a stranger. */
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

// Order is LOAD-BEARING: specific shapes run first so their replacement text
// survives into the skeleton; blunt catch-alls run last.
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
    // Keep the scheme; host, path, query and fragment all go.
    pattern: /\b(?<scheme>[A-Za-z][A-Za-z0-9+.-]*):\/\/[^\s"'`<>]+/gu,
    replace: (match) =>
      `${match.slice(0, match.indexOf(":"))}://[REDACTED:url]`,
  },
  {
    id: "absolute-path",
    // Two or more segments only, so a bare "/" is left alone.
    pattern: /(?:[A-Za-z]:[\\/]|\/)(?:[\w %.~+-]+[\\/])+[\w %.~+-]*/gu,
  },
  {
    id: "ip-address",
    pattern:
      /\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b/gu,
  },
  // BEFORE `phone`: whichever runs first wins the attribution, and a
  // Luhn-invalid run falls through to `phone`, which redacts it anyway.
  {
    id: "payment-card",
    pattern: /\b(?:\d[ -]?){12,18}\d\b/gu,
    replace: (match) =>
      luhnValid(match.replaceAll(/[^\d]/gu, "")) ? MARK("payment-card") : match,
  },
  // Lookarounds, not `\b`: otherwise a digit run INSIDE a longer handle
  // matches and the replacement splits that handle into two surviving halves.
  {
    id: "phone",
    pattern: /(?<![A-Za-z0-9])\+?\d[\d ()-]{8,}\d(?![A-Za-z0-9])/gu,
  },
  {
    id: "quoted-value",
    // This codebase interpolates owner values inside quotes.
    pattern: /"[^"\n]{1,4096}"|'[^'\n]{1,4096}'|`[^`\n]{1,4096}`/gu,
  },
  { id: "high-entropy", pattern: /[A-Za-z0-9+/=_-]{24,}/gu },
  { id: "long-token", pattern: /\S{64,}/gu },
  // The catch-all for owner PROSE interpolated unquoted: a run of this many
  // consecutive words is a sentence somebody wrote. LAST, so the structured
  // rules keep their attribution. It is why `standard` is defensible at all,
  // and why `strict` is still the default.
  {
    id: "sentence-run",
    pattern: /[\p{L}\p{N}'’]+(?:[ \t]+[\p{L}\p{N}'’]+){7,}/gu,
  },
];

// `payment-card` can return its match unchanged, so a per-rule count cannot
// come from `match().length` — every rule reports through this one path.
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

/** Re-scrubbing is safe: the `[REDACTED:x]` marks are short, unquoted and
 *  low-entropy, so no rule matches them. */
export function scrubProse(text: string, report: RedactionReport): string {
  let out = text;
  for (const rule of PROSE_RULES) out = applyRule(out, rule, report);
  if (out.length > PROSE_MAX_CHARS) {
    out = `${out.slice(0, PROSE_MAX_CHARS)}…${MARK("length-cap")}`;
    hit(report, "length-cap");
  }
  return out;
}

/** Support quotes the digest; the owner greps their own local log. */
export function digest12(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/** Correlates rows WITHIN one bundle; no cross-bundle linkability. */
export function hashIdentifier(value: string, salt: string): string {
  return `id:${createHash("sha256").update(`${salt}\u0000${value}`).digest("hex").slice(0, 12)}`;
}

export type LeafPolicy =
  | "drop"
  /** Scrubbed at `standard`, dropped entirely at `strict`. */
  | "prose"
  | "enum"
  | "number"
  | "timestamp"
  /** Owner-scoped id, emitted as a salted hash. */
  | "identifier"
  | "verbatim";

// `@` allowed so `fn@file.js:12` is an enum leaf, not a refused one.
const ENUM_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/u;
const TIMESTAMP_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u;
const VERBATIM_SHAPE = /^[\w .+:/@-]{0,64}$/u;

export interface LeafContext {
  readonly report: RedactionReport;
  /** One per bundle. */
  readonly salt: string;
}

/** A value failing its policy's shape is REFUSED, never passed through. */
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
 * The ONE deliberate relaxation in the walk below: without it a `strict`
 * bundle reports every setting as `[REDACTED]`, which is a blank page rather
 * than a safe bundle. The residual risk — a short lowercase SECRET under a
 * key whose name is not secret-shaped — is covered by `SECRET_KEY_PATTERN`
 * and `applyTripwire`, and disclosed in the bundle itself.
 */
const MACHINE_TOKEN = /^[a-z0-9][a-z0-9._:+-]{0,15}$/u;
/** A long hex/base32 run is a handle or a key, never a setting name. */
const OPAQUE_HANDLE = /^[0-9a-f]{12,}$/u;

function isMachineSetting(value: string): boolean {
  return MACHINE_TOKEN.test(value) && !OPAQUE_HANDLE.test(value);
}

/**
 * The shape here is NOT under our control: secret-shaped keys drop by name,
 * machine tokens survive, other strings are prose-scrubbed. Depth and width
 * are capped so a surprise structure cannot balloon the bundle.
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
 * The last gate. A hit means the policy above MISSED something: the value is
 * removed and the count rides in the bundle's own report, so the miss is
 * visible rather than silent. Values shorter than 4 characters are ignored —
 * they would match inside unrelated tokens and shred the document.
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
