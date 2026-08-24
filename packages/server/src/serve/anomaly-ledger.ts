/*
 * Local crash/anomaly ledger (#842).
 *
 * `gateway-log-store.ts` answers "what was the gateway saying"; it is a
 * ring of prose, rotated and bounded, and a crash three restarts ago is
 * long gone. This ledger answers the different question support actually
 * asks — "what has gone WRONG on this machine, how often, and where" —
 * and it answers it in structured, low-cardinality facts rather than
 * prose, so the record is aggregatable and, critically, so it can be put
 * in a shareable bundle without a redaction pass having to guess.
 *
 * Three properties make that true:
 *
 *  - **Structured by construction.** A record carries a `code` (a stable
 *    machine token, e.g. `vault.mount.schema-mismatch`), a `component`,
 *    a severity, and a `facts` map of numbers/booleans/enum tokens. There
 *    is no free-text field. The raw error message is kept only as a
 *    `messageDigest`; the plaintext never enters the ledger, so it cannot
 *    be leaked from it later.
 *  - **Stack fingerprints, not stacks.** Frames are reduced to
 *    `function@basename:line`. The directory — which on a real machine
 *    contains the owner's home directory and therefore their name — is
 *    dropped at record time, not at share time.
 *  - **Bounded and local.** A ring in memory, optionally mirrored to
 *    `<dir>/anomalies.jsonl` with the same rotation posture as the log
 *    store. Nothing here opens a socket; see the no-egress test.
 *
 * Determinism: the clock is injected (`now`). Nothing in this module reads
 * `Date.now()` or any randomness, so a seeded test produces byte-identical
 * ledgers across runs.
 */

import fs from "node:fs";
import path from "node:path";

import { digest12, SECRET_KEY_PATTERN } from "./diagnostics-redaction.js";

export const ANOMALY_KINDS = [
  "uncaught-exception",
  "unhandled-rejection",
  "process-exit",
  "vault-mount-failure",
  "migration-failure",
  "disk-full",
  "integrity-violation",
  "protocol-refusal",
  "peer-fault",
  "automation-fault",
  "budget-exceeded",
] as const;
export type AnomalyKind = (typeof ANOMALY_KINDS)[number];

export const ANOMALY_SEVERITIES = ["fatal", "error", "warn"] as const;
export type AnomalySeverity = (typeof ANOMALY_SEVERITIES)[number];

export type AnomalyFact = number | boolean | null;

export interface AnomalyRecord {
  /** Monotonic within a process. Resume/dedupe cursor for readers. */
  readonly seq: number;
  readonly at: string;
  readonly kind: AnomalyKind;
  readonly severity: AnomalySeverity;
  /** Stable, low-cardinality grouping token: `<area>.<site>.<reason>`. */
  readonly code: string;
  /** Emitting subsystem, e.g. `serve.vault-registry`. */
  readonly component: string;
  /** sha256/12 of the originating error message. Plaintext is never kept. */
  readonly messageDigest: string;
  /** `function@basename:line` frames, newest first. Directories dropped. */
  readonly stack: readonly string[];
  /** Numeric/boolean facts only — no strings, so nothing can be smuggled. */
  readonly facts: Readonly<Record<string, AnomalyFact>>;
}

export interface AnomalyInput {
  readonly kind: AnomalyKind;
  readonly severity: AnomalySeverity;
  readonly code: string;
  readonly component: string;
  /** Raw error/message. Digested on the way in; never stored. */
  readonly message?: string;
  readonly error?: unknown;
  readonly facts?: Readonly<Record<string, AnomalyFact>>;
}

/** Ring capacity — a few hundred anomalies is several months of a healthy
 *  machine and a single afternoon of an unhealthy one. */
const DEFAULT_CAPACITY = 512;
const FILE_NAME = "anomalies.jsonl";
const ROTATE_BYTES = 1024 * 1024;
const MAX_STACK_FRAMES = 12;
/** Refuse anything that is not a machine token, so `code`/`component`
 *  cannot become a smuggling channel for interpolated owner data. */
const TOKEN_SHAPE = /^[a-z0-9][a-z0-9.:-]{0,63}$/u;
const UNKNOWN_TOKEN = "unknown";

function token(value: string): string {
  return TOKEN_SHAPE.test(value) ? value : UNKNOWN_TOKEN;
}

/**
 * `at Foo.bar (/Users/priya/app/dist/serve/x.js:12:9)` ->
 * `Foo.bar@x.js:12`. Anonymous frames keep the location only. Frames that
 * do not parse are dropped rather than passed through — an unparsed frame
 * is exactly the case where a path would survive.
 */
export function fingerprintStack(stack: string | undefined): string[] {
  if (typeof stack !== "string") return [];
  const frames: string[] = [];
  for (const raw of stack.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("at ")) continue;
    const located = /\(?(?<file>[^()\s]+):(?<line>\d+):\d+\)?$/u.exec(trimmed);
    if (!located) continue;
    const file = path
      .basename(located.groups?.file ?? "")
      .replaceAll(/[^\w.-]/gu, "");
    if (file.length === 0) continue;
    const named = /^at\s+(?:async\s+)?(?<fn>[\w$.<>[\]]+)\s*\(/u.exec(trimmed);
    const fn = named?.groups?.fn ?? "";
    const at = located.groups?.line ?? "0";
    frames.push(fn.length > 0 ? `${fn}@${file}:${at}` : `${file}:${at}`);
    if (frames.length >= MAX_STACK_FRAMES) break;
  }
  return frames;
}

/** Facts are numbers and booleans only. A string-valued fact is dropped —
 *  the caller is asking for a channel this ledger does not have. Keys that
 *  look secret-shaped are dropped too, so a `retryToken: 3` cannot teach
 *  the next author that secret-shaped keys are fine here. */
function sanitizeFacts(
  facts: Readonly<Record<string, AnomalyFact>> | undefined
): Record<string, AnomalyFact> {
  const out: Record<string, AnomalyFact> = {};
  if (!facts) return out;
  for (const [key, value] of Object.entries(facts)) {
    if (!TOKEN_SHAPE.test(key) || SECRET_KEY_PATTERN.test(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean") out[key] = value;
    else if (value === null) out[key] = null;
  }
  return out;
}

export interface AnomalyLedgerOptions {
  /** Optional on-disk mirror directory. Omit for memory-only. */
  readonly dir?: string;
  readonly capacity?: number;
  /** Injected clock — epoch ms. Required to keep the ledger deterministic. */
  readonly now: () => number;
}

export class AnomalyLedger {
  private readonly records: AnomalyRecord[] = [];
  private readonly capacity: number;
  private readonly file: string | undefined;
  private readonly now: () => number;
  private nextSeq = 1;
  private droppedWrites = 0;

  constructor(options: AnomalyLedgerOptions) {
    this.capacity = Math.max(1, options.capacity ?? DEFAULT_CAPACITY);
    this.now = options.now;
    this.file = options.dir ? path.join(options.dir, FILE_NAME) : undefined;
  }

  record(input: AnomalyInput): AnomalyRecord {
    const message =
      input.message ??
      (input.error instanceof Error ? input.error.message : undefined) ??
      (input.error === undefined ? "" : String(input.error));
    const stack = input.error instanceof Error ? input.error.stack : undefined;
    const entry: AnomalyRecord = {
      seq: this.nextSeq,
      at: new Date(this.now()).toISOString(),
      kind: input.kind,
      severity: input.severity,
      code: token(input.code),
      component: token(input.component),
      messageDigest: digest12(message),
      stack: fingerprintStack(stack),
      facts: sanitizeFacts(input.facts),
    };
    this.nextSeq += 1;
    this.records.push(entry);
    if (this.records.length > this.capacity)
      this.records.splice(0, this.records.length - this.capacity);
    this.persist(entry);
    return entry;
  }

  /** Newest-last. */
  snapshot(): readonly AnomalyRecord[] {
    return [...this.records];
  }

  /** `code` -> occurrences, for the bundle's "what keeps happening" lane. */
  histogram(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const entry of this.records)
      out[entry.code] = (out[entry.code] ?? 0) + 1;
    return out;
  }

  get dropped(): number {
    return this.droppedWrites;
  }

  /** Best-effort mirror. A ledger that crashes the process it exists to
   *  observe is worse than no ledger, so every failure is swallowed and
   *  counted. */
  private persist(entry: AnomalyRecord): void {
    const file = this.file;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        if (fs.statSync(file).size > ROTATE_BYTES)
          fs.renameSync(file, `${file}.1`);
      } catch {
        // No file yet, or an unreadable stat — the append below decides.
      }
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
    } catch {
      this.droppedWrites += 1;
    }
  }
}

/**
 * Read a persisted ledger back (current generation plus the rotated one),
 * newest-last. Unparseable lines are skipped: a torn final line from a
 * hard kill must not make the whole post-mortem unreadable.
 */
export function readAnomalyLedger(dir: string): AnomalyRecord[] {
  const out: AnomalyRecord[] = [];
  for (const name of [`${FILE_NAME}.1`, FILE_NAME]) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        out.push(JSON.parse(line) as AnomalyRecord);
      } catch {
        continue;
      }
    }
  }
  return out;
}
