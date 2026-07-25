/**
 * One durable cursor engine for every automation trigger (issue #541).
 *
 * A source answers "which ordered elements exist after this position?".
 * The engine advances the position before firing, bounds catch-up, and stores
 * gap metadata uniformly. Cron is a virtual source computed on read; vault
 * data/condition, authenticated ingress, and provider feeds are injected
 * readers over the same contract.
 */

import type { AutomationTriggerCursor, AutomationTriggerStore } from '@centraid/app-engine';
import type { Host, ReconcileResult } from './host.js';
import type { Row } from '../scaffold/app.js';
import { isDeniedTriggerCursorEntity, type Trigger } from '../manifest/manifest.js';
import { floorMinute, readCronCursor } from './cron-cursor.js';
import { cronMatches } from './cron-match.js';

export const DEFAULT_TRIGGER_CATCH_UP_CAP = 50;

export type CursorSourceKind = Trigger['kind'];

export interface CursorElement {
  /** Stable source-native position/id for this element. */
  position: string;
  occurredAt: number;
  payload?: unknown;
}

export interface CursorReadResult {
  elements: CursorElement[];
  /** Serialized next source position. Undefined preserves the current one. */
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
  getCursor(automationId: string, triggerIndex: number): AutomationTriggerCursor | undefined;
  putCursor(input: {
    automationId: string;
    triggerIndex: number;
    sourceKind: string;
    positionJson?: string;
    windowFrom?: number;
    windowTo?: number;
    skipped?: number;
    gapReason?: string;
    updatedAt: number;
  }): void;
  deleteCursorsNotIn?(automationIds: readonly string[]): number;
}

export interface VaultCursorEngineOptions {
  /** Compatibility fire seam for cron-only callers. */
  fire: (ref: string) => void | Promise<void>;
  /** Fire one source element. Production hosts use this for every kind. */
  fireCursor?: (input: TriggerCursorFireInput) => void | Promise<void>;
  /** Read non-cron sources. */
  readCursor?: (input: TriggerCursorReadInput) => Promise<CursorReadResult>;
  /**
   * Legacy condition/data callback. Retained only for injected schedulers;
   * production uses readCursor + fireCursor.
   */
  evaluate?: (ref: string, triggerIndex: number) => void | Promise<void>;
  store?: CursorStore | AutomationTriggerStore;
  now?: () => Date;
  onError?: (err: unknown, ref: string) => void;
  nudgeDelayMs?: number;
  onTick?: (at: Date) => void;
  onDormancyChange?: (dormant: boolean, at: Date) => void | Promise<void>;
  catchUpCap?: number;
}

interface CursorRegistration {
  ref: string;
  triggerIndex: number;
  trigger: Trigger;
}

class MemoryCursorStore implements CursorStore {
  private readonly rows = new Map<string, AutomationTriggerCursor>();

  getCursor(automationId: string, triggerIndex: number): AutomationTriggerCursor | undefined {
    return this.rows.get(`${automationId}\u0000${triggerIndex}`);
  }

  putCursor(input: Parameters<CursorStore['putCursor']>[0]): void {
    this.rows.set(`${input.automationId}\u0000${input.triggerIndex}`, {
      automationId: input.automationId,
      triggerIndex: input.triggerIndex,
      sourceKind: input.sourceKind,
      ...(input.positionJson !== undefined ? { positionJson: input.positionJson } : {}),
      ...(input.windowFrom !== undefined ? { windowFrom: input.windowFrom } : {}),
      ...(input.windowTo !== undefined ? { windowTo: input.windowTo } : {}),
      skipped: input.skipped ?? 0,
      ...(input.gapReason !== undefined ? { gapReason: input.gapReason } : {}),
      updatedAt: input.updatedAt,
    });
  }

  deleteCursorsNotIn(automationIds: readonly string[]): number {
    const keep = new Set(automationIds);
    let deleted = 0;
    for (const [key, row] of this.rows) {
      if (keep.has(row.automationId)) continue;
      this.rows.delete(key);
      deleted++;
    }
    return deleted;
  }
}

export function isDeniedCursorEntity(entity: string): boolean {
  return isDeniedTriggerCursorEntity(entity);
}

export function assertTriggerCursorAllowed(trigger: Trigger): void {
  const entities =
    trigger.kind === 'condition'
      ? [trigger.entity]
      : trigger.kind === 'data'
        ? [...trigger.entities]
        : [];
  const denied = entities.find(isDeniedCursorEntity);
  if (denied) {
    throw new Error(
      `automation trigger cursor may not target "${denied}" (loop-sensitive runtime table)`,
    );
  }
}

function scheduleExpr(trigger: Trigger): string | undefined {
  if (trigger.kind === 'cron') return trigger.expr;
  if (trigger.kind === 'condition' || trigger.kind === 'data') {
    return trigger.every ?? '*/5 * * * *';
  }
  if (trigger.kind === 'event') return trigger.every ?? '*/5 * * * *';
  return undefined;
}

function cursorSourceKind(trigger: Trigger): CursorSourceKind {
  return trigger.kind;
}

function cursorIdentity(trigger: Trigger): string {
  if (trigger.kind !== 'event') return trigger.kind;
  return `event:${trigger.connectorKind}:${trigger.event}:${JSON.stringify(trigger.filter ?? {})}`;
}

export interface LocalCursorScheduler extends Host {
  nudge(entityTypes?: readonly string[]): void;
  nudgeIngress?(sourceKey: string): void;
  start(): void;
  stop(): Promise<void>;
}

export class VaultCursorEngine implements LocalCursorScheduler {
  private readonly registrations = new Map<string, CursorRegistration>();
  private readonly fire: VaultCursorEngineOptions['fire'];
  private readonly fireCursor?: VaultCursorEngineOptions['fireCursor'];
  private readonly readCursor?: VaultCursorEngineOptions['readCursor'];
  private readonly evaluate?: VaultCursorEngineOptions['evaluate'];
  private readonly store: CursorStore;
  private readonly now: () => Date;
  private readonly onError?: VaultCursorEngineOptions['onError'];
  private readonly onTick?: VaultCursorEngineOptions['onTick'];
  private readonly onDormancyChange?: VaultCursorEngineOptions['onDormancyChange'];
  private readonly nudgeDelayMs: number;
  private readonly catchUpCap: number;
  private boundary?: ReturnType<typeof setTimeout>;
  private interval?: ReturnType<typeof setInterval>;
  private nudgeTimer?: ReturnType<typeof setTimeout>;
  private nudgeAll = false;
  private readonly nudgedEntities = new Set<string>();
  private lastProcessedMinute?: number;
  private readonly inFlight = new Map<string, { promise: Promise<void>; dirty: boolean }>();

  constructor(options: VaultCursorEngineOptions) {
    this.fire = options.fire;
    this.fireCursor = options.fireCursor;
    this.readCursor = options.readCursor;
    this.evaluate = options.evaluate;
    this.store = options.store ?? new MemoryCursorStore();
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError;
    this.onTick = options.onTick;
    this.onDormancyChange = options.onDormancyChange;
    this.nudgeDelayMs = options.nudgeDelayMs ?? 25;
    this.catchUpCap = options.catchUpCap ?? DEFAULT_TRIGGER_CATCH_UP_CAP;
  }

  async register(row: Row): Promise<void> {
    const wasDormant = this.registrations.size === 0;
    this.dropRegistrations(row.ref);
    if (row.enabled) {
      row.triggers.forEach((trigger, triggerIndex) => {
        assertTriggerCursorAllowed(trigger);
        this.registrations.set(this.key(row.ref, triggerIndex), {
          ref: row.ref,
          triggerIndex,
          trigger,
        });
      });
    }
    await this.bootstrapTriggers(row.ref, false);
    await this.notifyDormancy(wasDormant);
  }

  async unregister(ref: string): Promise<void> {
    const wasDormant = this.registrations.size === 0;
    this.dropRegistrations(ref);
    await this.notifyDormancy(wasDormant);
  }

  async list(): Promise<readonly string[]> {
    return [...new Set([...this.registrations.values()].map((entry) => entry.ref))].sort();
  }

  async reconcile(rows: ReadonlyArray<Row>): Promise<ReconcileResult> {
    const wasDormant = this.registrations.size === 0;
    const previous = new Map(this.registrations);
    const before = this.signatureByRef(previous);
    const next = new Map<string, CursorRegistration>();
    for (const row of rows) {
      if (!row.enabled) continue;
      row.triggers.forEach((trigger, triggerIndex) => {
        assertTriggerCursorAllowed(trigger);
        next.set(this.key(row.ref, triggerIndex), { ref: row.ref, triggerIndex, trigger });
      });
    }
    const after = this.signatureByRef(next);
    const added = [...after.keys()].filter((ref) => !before.has(ref)).sort();
    const updated = [...after.keys()]
      .filter((ref) => before.has(ref) && before.get(ref) !== after.get(ref))
      .sort();
    const removed = [...before.keys()].filter((ref) => !after.has(ref)).sort();
    this.registrations.clear();
    for (const [key, value] of next) this.registrations.set(key, value);
    try {
      for (const ref of [...added, ...updated]) await this.bootstrapTriggers(ref, true);
    } catch (error) {
      this.registrations.clear();
      for (const [key, value] of previous) this.registrations.set(key, value);
      throw error;
    }
    this.store.deleteCursorsNotIn?.([...after.keys()]);
    await this.notifyDormancy(wasDormant);
    return { added, updated, removed };
  }

  tick(): void {
    const at = this.now();
    const minute = floorMinute(at.getTime());
    if (minute === this.lastProcessedMinute) return;
    this.lastProcessedMinute = minute;
    if (this.registrations.size === 0) return;
    try {
      this.onTick?.(at);
    } catch (error) {
      this.onError?.(error, '__scheduler');
    }
    for (const registration of this.registrations.values()) {
      const expr = scheduleExpr(registration.trigger);
      if (expr && cronMatches(expr, at)) this.processSafely(registration, at);
    }
  }

  nudge(entityTypes?: readonly string[]): void {
    if (entityTypes === undefined) {
      this.nudgeAll = true;
      this.nudgedEntities.clear();
    } else if (!this.nudgeAll) {
      for (const entity of entityTypes) this.nudgedEntities.add(entity);
    }
    this.armNudge();
  }

  nudgeIngress(sourceKey: string): void {
    const at = this.now();
    for (const registration of this.registrations.values()) {
      const trigger = registration.trigger;
      const selected =
        (trigger.kind === 'webhook' && 'id' in trigger && trigger.id === sourceKey) ||
        (trigger.kind === 'event' && eventSourceKey(trigger) === sourceKey);
      if (selected) this.processSafely(registration, at);
    }
  }

  start(): void {
    if (this.boundary || this.interval) return;
    const now = this.now();
    const delay = 60_000 - (now.getSeconds() * 1_000 + now.getMilliseconds());
    this.boundary = setTimeout(() => {
      this.boundary = undefined;
      this.tick();
      this.interval = setInterval(() => this.tick(), 60_000);
      this.interval.unref?.();
    }, delay);
    this.boundary.unref?.();
  }

  async stop(): Promise<void> {
    if (this.boundary) clearTimeout(this.boundary);
    if (this.interval) clearInterval(this.interval);
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    this.boundary = undefined;
    this.interval = undefined;
    this.nudgeTimer = undefined;
    this.nudgeAll = false;
    this.nudgedEntities.clear();
    await Promise.allSettled([...this.inFlight.values()].map((state) => state.promise));
  }

  private armNudge(): void {
    if (this.nudgeTimer) return;
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = undefined;
      const all = this.nudgeAll;
      const entities = new Set(this.nudgedEntities);
      this.nudgeAll = false;
      this.nudgedEntities.clear();
      const at = this.now();
      for (const registration of this.registrations.values()) {
        const trigger = registration.trigger;
        const selected =
          trigger.kind === 'data' &&
          (all || trigger.entities.some((entity) => entities.has(entity)));
        if (selected) this.processSafely(registration, at);
      }
    }, this.nudgeDelayMs);
    this.nudgeTimer.unref?.();
  }

  private processSafely(registration: CursorRegistration, at: Date): void {
    void this.serialize(registration, at).catch((error) => this.onError?.(error, registration.ref));
  }

  private serialize(registration: CursorRegistration, at: Date): Promise<void> {
    const key = this.key(registration.ref, registration.triggerIndex);
    const active = this.inFlight.get(key);
    if (active) {
      active.dirty = true;
      return active.promise;
    }
    const state = { promise: Promise.resolve(), dirty: false };
    state.promise = (async () => {
      do {
        state.dirty = false;
        await this.process(registration, at);
      } while (state.dirty);
    })().finally(() => {
      if (this.inFlight.get(key) === state) this.inFlight.delete(key);
    });
    this.inFlight.set(key, state);
    return state.promise;
  }

  private async process(registration: CursorRegistration, at: Date): Promise<void> {
    const storedCursor = this.store.getCursor(registration.ref, registration.triggerIndex);
    // If a trigger changed in place at the same array index, the previous
    // source position is meaningless to its replacement.
    const cursor =
      storedCursor?.sourceKind === cursorIdentity(registration.trigger) ? storedCursor : undefined;
    let result: CursorReadResult;
    if (registration.trigger.kind === 'cron') {
      result = readCronCursor(registration.trigger.expr, cursor, at);
    } else if (this.readCursor) {
      result = await this.readCursor({
        automationRef: registration.ref,
        trigger: registration.trigger,
        triggerIndex: registration.triggerIndex,
        ...(cursor ? { cursor } : {}),
        now: at,
        limit: this.catchUpCap,
      });
    } else {
      await this.evaluate?.(registration.ref, registration.triggerIndex);
      result = {
        elements: [],
        positionJson: cursor?.positionJson ?? JSON.stringify(at.getTime()),
      };
    }
    const skipped = Math.max(0, result.skipped ?? 0);
    this.store.putCursor({
      automationId: registration.ref,
      triggerIndex: registration.triggerIndex,
      sourceKind: cursorIdentity(registration.trigger),
      ...(result.positionJson !== undefined
        ? { positionJson: result.positionJson }
        : cursor?.positionJson !== undefined
          ? { positionJson: cursor.positionJson }
          : {}),
      ...(result.windowFrom !== undefined ? { windowFrom: result.windowFrom } : {}),
      ...(result.windowTo !== undefined ? { windowTo: result.windowTo } : {}),
      skipped,
      ...(result.gapReason !== undefined ? { gapReason: result.gapReason } : {}),
      updatedAt: at.getTime(),
    });
    for (const element of result.elements.slice(0, this.catchUpCap)) {
      const fireInput: TriggerCursorFireInput = {
        automationRef: registration.ref,
        trigger: registration.trigger,
        triggerIndex: registration.triggerIndex,
        sourceKind: cursorSourceKind(registration.trigger),
        element,
        skipped,
        ...(result.windowFrom !== undefined ? { windowFrom: result.windowFrom } : {}),
        ...(result.windowTo !== undefined ? { windowTo: result.windowTo } : {}),
        ...(result.gapReason !== undefined ? { gapReason: result.gapReason } : {}),
      };
      if (this.fireCursor) await this.fireCursor(fireInput);
      else if (registration.trigger.kind === 'cron') await this.fire(registration.ref);
    }
  }

  private async bootstrapTriggers(ref: string, allowLegacyEvaluate: boolean): Promise<void> {
    if (!this.readCursor && (!allowLegacyEvaluate || !this.evaluate)) return;
    const at = this.now();
    for (const registration of this.registrations.values()) {
      if (
        registration.ref !== ref ||
        (registration.trigger.kind !== 'data' &&
          registration.trigger.kind !== 'webhook' &&
          registration.trigger.kind !== 'event')
      ) {
        continue;
      }
      if (this.store.getCursor(ref, registration.triggerIndex)) continue;
      try {
        await this.process(registration, at);
      } catch (error) {
        // Provider availability is not automation-definition readiness.
        // Keep an event trigger registered when its exact account is offline
        // or needs auth; the next cadence retries through the same cursor.
        // Data/condition bootstrap remains strict because its initial vault
        // position is part of install-time grant readiness.
        if (registration.trigger.kind !== 'event') throw error;
        this.onError?.(error, registration.ref);
      }
    }
  }

  private dropRegistrations(ref: string): void {
    for (const [key, registration] of this.registrations) {
      if (registration.ref === ref) this.registrations.delete(key);
    }
  }

  private async notifyDormancy(wasDormant: boolean): Promise<void> {
    const dormant = this.registrations.size === 0;
    if (dormant === wasDormant || !this.onDormancyChange) return;
    await this.onDormancyChange(dormant, this.now());
  }

  private key(ref: string, triggerIndex: number): string {
    return `${ref}\u0000${triggerIndex}`;
  }

  private signatureByRef(rows: ReadonlyMap<string, CursorRegistration>): Map<string, string> {
    const grouped = new Map<string, Array<{ index: number; trigger: Trigger }>>();
    for (const registration of rows.values()) {
      const list = grouped.get(registration.ref) ?? [];
      list.push({ index: registration.triggerIndex, trigger: registration.trigger });
      grouped.set(registration.ref, list);
    }
    return new Map(
      [...grouped].map(([ref, triggers]) => [
        ref,
        JSON.stringify(triggers.sort((a, b) => a.index - b.index)),
      ]),
    );
  }
}

export function eventSourceKey(trigger: Extract<Trigger, { kind: 'event' }>): string {
  return `event:${trigger.connectorKind}:${trigger.event}`;
}
