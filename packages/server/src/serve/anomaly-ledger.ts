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
  readonly seq: number;
  readonly at: string;
  readonly kind: AnomalyKind;
  readonly severity: AnomalySeverity;
  readonly code: string;
  readonly component: string;
  readonly messageDigest: string;
  readonly stack: readonly string[];
  readonly facts: Readonly<Record<string, AnomalyFact>>;
}

export interface AnomalyInput {
  readonly kind: AnomalyKind;
  readonly severity: AnomalySeverity;
  readonly code: string;
  readonly component: string;
  readonly message?: string;
  readonly error?: unknown;
  readonly facts?: Readonly<Record<string, AnomalyFact>>;
}

const DEFAULT_CAPACITY = 512;
const FILE_NAME = "anomalies.jsonl";
const ROTATE_BYTES = 1024 * 1024;
const MAX_STACK_FRAMES = 12;
const TOKEN_SHAPE = /^[a-z0-9][a-z0-9.:-]{0,63}$/u;
const UNKNOWN_TOKEN = "unknown";

function token(value: string): string {
  return TOKEN_SHAPE.test(value) ? value : UNKNOWN_TOKEN;
}

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
  readonly dir?: string;
  readonly capacity?: number;
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

  snapshot(): readonly AnomalyRecord[] {
    return [...this.records];
  }

  histogram(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const entry of this.records)
      out[entry.code] = (out[entry.code] ?? 0) + 1;
    return out;
  }

  get dropped(): number {
    return this.droppedWrites;
  }

  private persist(entry: AnomalyRecord): void {
    const file = this.file;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        if (fs.statSync(file).size > ROTATE_BYTES)
          fs.renameSync(file, `${file}.1`);
      } catch {
        // Intentionally empty.
      }
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
    } catch {
      this.droppedWrites += 1;
    }
  }
}

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
