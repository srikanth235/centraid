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
  skipped: number;
  windowFrom?: number;
  windowTo?: number;
  gapReason?: string;
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
  /** Read non-cron sources. */
  readCursor?: (input: TriggerCursorReadInput) => Promise<CursorReadResult>;
  /** Legacy condition/data callback; retained only for injected schedulers. */
  evaluate?: (ref: string, triggerIndex: number) => void | Promise<void>;
  store?: CursorStore | AutomationTriggerStore;
  now?: () => Date;
  onError?: (err: unknown, ref: string) => void;
  nudgeDelayMs?: number;
  onTick?: (at: Date) => void;
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
