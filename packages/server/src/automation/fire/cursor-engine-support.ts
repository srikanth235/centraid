import type {
  AutomationTriggerCursor,
  AutomationTriggerStore,
} from "@centraid/server/engine";

import { resolveCronTimezone } from "../cron-timezone.js";
import {
  CONDITION_DEFAULT_EVERY,
  DATA_DEFAULT_EVERY,
  EVENT_DEFAULT_EVERY,
  isDeniedTriggerCursorEntity,
} from "../manifest/manifest.js";
import type { Trigger } from "../manifest/manifest.js";
import type { Row } from "../scaffold/app.js";
import type { Host } from "./host.js";

export const DEFAULT_TRIGGER_CATCH_UP_CAP = 50;

/**
 * HOW OFTEN ONE ELEMENT IS TRIED BEFORE IT IS GIVEN UP ON (#1014, B1).
 *
 * A trigger element used to be acknowledged the moment its fire RETURNED,
 * and a handler failure returns: `fireAutomation` reported
 * `{outcome.ok: false}` without throwing, so a Gmail message whose handler hit
 * a transient error was consumed and never seen again. The other extreme is
 * no better — retrying forever parks the whole cursor behind one bad element.
 *
 * So: attempts are COUNTED per element, spaced by the backoff below, and at
 * the cap the element is DEAD-LETTERED — recorded on the cursor row with its
 * error, reported to health and written to the member's notices — before the
 * batch is allowed to settle past it. Never silently acked, never retried
 * forever.
 */
export const TRIGGER_MAX_ATTEMPTS = 5;

/**
 * Backoff between attempts, indexed by attempts already made. The last entry
 * is the ceiling; a tick that arrives before the delay elapses simply leaves
 * the element for the next one and moves on to the rest of the batch.
 */
export const TRIGGER_RETRY_BACKOFF_MS: readonly number[] = [
  15_000,
  60_000,
  5 * 60_000,
  15 * 60_000,
];

export function triggerRetryDelayMs(attempts: number): number {
  const index = Math.min(
    Math.max(0, attempts - 1),
    TRIGGER_RETRY_BACKOFF_MS.length - 1
  );
  return TRIGGER_RETRY_BACKOFF_MS[index] ?? 15_000;
}

/** How many dead-lettered elements one cursor row keeps. */
export const TRIGGER_DEAD_LETTER_KEEP = 20;

export type CursorSourceKind = Trigger["kind"];

export interface CursorElement {
  /** Stable source-native id; unique per DELIVERY OCCURRENCE (idempotency). */
  position: string;
  occurredAt: number;
  payload?: unknown;
  /**
   * Position committed once THIS element is acknowledged; enables safe
   * truncation.
   */
  positionJson?: string;
}

export interface CursorReadResult {
  /**
   * Ordered elements after the supplied cursor, oldest first; never past
   * `limit`.
   */
  elements: CursorElement[];
  /** Serialized next source position; undefined preserves the current one. */
  positionJson?: string;
  skipped?: number;
  windowFrom?: number;
  windowTo?: number;
  gapReason?: string;
}

export interface TriggerCursorReadInput {
  automationRef: string;
  trigger: Trigger;
  triggerIndex: number;
  cursor?: AutomationTriggerCursor;
  now: Date;
  limit: number;
}

export interface TriggerCursorFireInput {
  automationRef: string;
  trigger: Trigger;
  triggerIndex: number;
  sourceKind: CursorSourceKind;
  element: CursorElement;
  /** 1 for the first delivery; the run id is keyed by it (#1014, B1). */
  attempt: number;
  skipped: number;
  windowFrom?: number;
  windowTo?: number;
  gapReason?: string;
}

/** One element the engine gave up on, as it is stored and reported. */
export interface TriggerDeadLetterEntry {
  position: string;
  occurredAt: number;
  attempts: number;
  error: string;
  deadLetteredAt: number;
}

export interface TriggerDeadLetter extends TriggerDeadLetterEntry {
  automationRef: string;
  triggerIndex: number;
  sourceKind: CursorSourceKind;
}

export function readDeadLetters(
  raw: string | undefined
): TriggerDeadLetterEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): TriggerDeadLetterEntry[] => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry))
        return [];
      const value = entry as Record<string, unknown>;
      if (typeof value.position !== "string") return [];
      return [
        {
          position: value.position,
          occurredAt:
            typeof value.occurredAt === "number" &&
            Number.isFinite(value.occurredAt)
              ? value.occurredAt
              : 0,
          attempts:
            typeof value.attempts === "number" &&
            Number.isFinite(value.attempts)
              ? value.attempts
              : 0,
          error: typeof value.error === "string" ? value.error : "",
          deadLetteredAt:
            typeof value.deadLetteredAt === "number" &&
            Number.isFinite(value.deadLetteredAt)
              ? value.deadLetteredAt
              : 0,
        },
      ];
    });
  } catch {
    return [];
  }
}

export interface CursorStore {
  getCursor: (
    automationId: string,
    triggerIndex: number
  ) => AutomationTriggerCursor | undefined;
  putCursor: (input: {
    automationId: string;
    triggerIndex: number;
    sourceKind: string;
    positionJson?: string;
    pendingJson?: string;
    windowFrom?: number;
    windowTo?: number;
    skipped?: number;
    gapReason?: string;
    deadLetterJson?: string;
    updatedAt: number;
  }) => void;
  deleteCursorsNotIn?: (retained: readonly CursorRetentionKey[]) => number;
}

/** One declared `(automation, trigger index)` slot whose cursor must survive. */
export interface CursorRetentionKey {
  automationId: string;
  triggerIndex: number;
}

export interface VaultCursorEngineOptions {
  /** Compatibility fire seam for cron-only callers. */
  fire: (ref: string) => void | Promise<void>;
  /** Fire one source element. Production hosts use this for every kind. */
  fireCursor?: (input: TriggerCursorFireInput) => void | Promise<void>;
  /**
   * An element that reached `TRIGGER_MAX_ATTEMPTS`. Best-effort and never
   * allowed to fail the batch: the durable record is the cursor row, and this
   * is how it reaches health and the member's notices.
   */
  onDeadLetter?: (entry: TriggerDeadLetter) => void | Promise<void>;
  /** Attempts before an element is dead-lettered; defaults to the constant. */
  maxAttempts?: number;
  /** Read non-cron sources. */
  readCursor?: (input: TriggerCursorReadInput) => Promise<CursorReadResult>;
  /** Legacy condition/data callback; retained only for injected schedulers. */
  evaluate?: (ref: string, triggerIndex: number) => void | Promise<void>;
  store?: CursorStore | AutomationTriggerStore;
  now?: () => Date;
  onError?: (err: unknown, ref: string) => void;
  nudgeDelayMs?: number;
  onTick?: (at: Date) => void;
  /**
   * The owner's background pause (#528), applied where the WORK is rather
   * than where the fire is. A paused ref is not processed at all: no cursor
   * read, no element consumed, no registration dropped — the next tick or
   * nudge after the pause lifts simply proceeds. The host decides which refs
   * this covers; `fireAutomation` keeps its own check as the backstop for a
   * fire that reaches it by another road.
   */
  shouldPauseBackground?: (ref: string) => boolean;
  onDormancyChange?: (dormant: boolean, at: Date) => void | Promise<void>;
  catchUpCap?: number;
  /**
   * Gateway default cron timezone (#570 tier 2); re-read each
   * register/reconcile; absent/invalid → host-local.
   */
  defaultCronTimeZone?: () => string | undefined;
}

/** One cron expression plus its resolved match zone (undefined = host-local). */
export type CronSchedule = {
  readonly expr: string;
  readonly timeZone?: string;
};

export interface CursorRegistration {
  ref: string;
  triggerIndex: number;
  trigger: Trigger;
  /**
   * Every cron schedule this registration fires, zones resolved at
   * registration time.
   */
  cronSchedules?: readonly CronSchedule[];
}

/**
 * Cursor registrations one automation contributes — one per trigger, EXCEPT
 * cron: all cron triggers collapse into the first cron index's registration.
 */
export function registrationsFor(
  row: Row,
  defaultTimeZone?: string | null
): CursorRegistration[] {
  for (const trigger of row.triggers) assertTriggerCursorAllowed(trigger);
  const cronSchedules: CronSchedule[] = row.triggers.flatMap((trigger) => {
    if (trigger.kind !== "cron") return [];
    const timeZone = resolveCronTimezone(trigger.tz, defaultTimeZone);
    return [
      { expr: trigger.expr, ...(timeZone === undefined ? {} : { timeZone }) },
    ];
  });
  const firstCron = row.triggers.findIndex(
    (trigger) => trigger.kind === "cron"
  );
  return row.triggers.flatMap((trigger, triggerIndex): CursorRegistration[] => {
    if (trigger.kind !== "cron")
      return [{ ref: row.ref, triggerIndex, trigger }];
    if (triggerIndex !== firstCron) return [];
    return [{ ref: row.ref, triggerIndex, trigger, cronSchedules }];
  });
}

/** Every `(automation, trigger index)` slot the desired set declares. */
export function retentionKeysFor(
  rows: ReadonlyArray<Row>
): CursorRetentionKey[] {
  return rows.flatMap((row) =>
    row.triggers.map((_trigger, triggerIndex) => ({
      automationId: row.ref,
      triggerIndex,
    }))
  );
}

export interface PendingFireBatch {
  targetPositionJson?: string;
  elements: CursorElement[];
  acknowledged: string[];
  /** Failed deliveries per element position (#1014, B1). */
  attempts?: Record<string, number>;
  /** Epoch ms before which a failed element is not retried. */
  retryAfter?: Record<string, number>;
  skipped: number;
  windowFrom?: number;
  windowTo?: number;
  gapReason?: string;
}

export function readPendingBatch(
  raw: string | undefined
): PendingFireBatch | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      return undefined;
    const value = parsed as Record<string, unknown>;
    if (!Array.isArray(value.elements) || !Array.isArray(value.acknowledged))
      return undefined;
    const elements = value.elements.flatMap((entry): CursorElement[] => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry))
        return [];
      const element = entry as Record<string, unknown>;
      if (
        typeof element.position !== "string" ||
        typeof element.occurredAt !== "number" ||
        !Number.isFinite(element.occurredAt)
      ) {
        return [];
      }
      return [
        {
          position: element.position,
          occurredAt: element.occurredAt,
          ...("payload" in element ? { payload: element.payload } : {}),
          ...(typeof element.positionJson === "string"
            ? { positionJson: element.positionJson }
            : {}),
        },
      ];
    });
    if (elements.length !== value.elements.length) return undefined;
    const acknowledged = value.acknowledged.filter(
      (entry): entry is string => typeof entry === "string"
    );
    const numberMap = (source: unknown): Record<string, number> => {
      if (
        source === null ||
        typeof source !== "object" ||
        Array.isArray(source)
      )
        return {};
      const out: Record<string, number> = {};
      for (const [key, entry] of Object.entries(
        source as Record<string, unknown>
      ))
        if (typeof entry === "number" && Number.isFinite(entry))
          out[key] = entry;
      return out;
    };
    const attempts = numberMap(value.attempts);
    const retryAfter = numberMap(value.retryAfter);
    const skipped =
      typeof value.skipped === "number" && Number.isFinite(value.skipped)
        ? Math.max(0, value.skipped)
        : 0;
    return {
      ...(typeof value.targetPositionJson === "string"
        ? { targetPositionJson: value.targetPositionJson }
        : {}),
      elements,
      acknowledged,
      ...(Object.keys(attempts).length > 0 ? { attempts } : {}),
      ...(Object.keys(retryAfter).length > 0 ? { retryAfter } : {}),
      skipped,
      ...(typeof value.windowFrom === "number" &&
      Number.isFinite(value.windowFrom)
        ? { windowFrom: value.windowFrom }
        : {}),
      ...(typeof value.windowTo === "number" && Number.isFinite(value.windowTo)
        ? { windowTo: value.windowTo }
        : {}),
      ...(typeof value.gapReason === "string"
        ? { gapReason: value.gapReason }
        : {}),
    };
  } catch {
    return undefined;
  }
}

export function isDeniedCursorEntity(entity: string): boolean {
  return isDeniedTriggerCursorEntity(entity);
}

export function assertTriggerCursorAllowed(trigger: Trigger): void {
  const entities =
    trigger.kind === "condition"
      ? [trigger.entity]
      : trigger.kind === "data"
        ? [...trigger.entities]
        : [];
  const denied = entities.find(isDeniedCursorEntity);
  if (denied) {
    throw new Error(
      `automation trigger cursor may not target "${denied}" (loop-sensitive runtime table)`
    );
  }
}

export function scheduleExpr(trigger: Trigger): string | undefined {
  if (trigger.kind === "cron") return trigger.expr;
  if (trigger.kind === "condition")
    return trigger.every ?? CONDITION_DEFAULT_EVERY;
  if (trigger.kind === "data") return trigger.every ?? DATA_DEFAULT_EVERY;
  if (trigger.kind === "event") return trigger.every ?? EVENT_DEFAULT_EVERY;
  return undefined;
}

export function cursorSourceKind(trigger: Trigger): CursorSourceKind {
  return trigger.kind;
}

export function cursorIdentity(trigger: Trigger): string {
  if (trigger.kind !== "event") return trigger.kind;
  return `event:${trigger.connectorKind}:${trigger.event}:${JSON.stringify(trigger.filter ?? {})}`;
}

export interface LocalCursorScheduler extends Host {
  nudge: (entityTypes?: readonly string[]) => void;
  nudgeIngress?: (sourceKey: string) => void;
  start: () => void;
  stop: () => Promise<void>;
}

/**
 * Append one given-up-on element to a cursor's tail, replacing any earlier
 * entry for the same position and keeping only the last
 * `TRIGGER_DEAD_LETTER_KEEP` (#1014, B1).
 */
export function appendDeadLetter(
  existing: readonly TriggerDeadLetterEntry[],
  entry: TriggerDeadLetterEntry
): TriggerDeadLetterEntry[] {
  return [
    ...existing.filter((prior) => prior.position !== entry.position),
    entry,
  ].slice(-TRIGGER_DEAD_LETTER_KEEP);
}
