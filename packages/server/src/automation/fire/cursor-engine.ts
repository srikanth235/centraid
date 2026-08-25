/**
 * One durable cursor engine for every automation trigger (#541).
 *
 * A source answers "which ordered elements exist after this position?".
 * The engine writes a pending receipt before firing, acknowledges each
 * element after its terminal turn, and advances the source position only
 * after the whole bounded batch settles. Cron is a virtual source computed
 * on read; vault data/condition, authenticated ingress, and provider feeds
 * are injected readers over the same contract.
 */

import type { Trigger } from "../manifest/manifest.js";
import type { Row } from "../scaffold/app.js";
import { floorMinute, readCronCursor } from "./cron-cursor.js";
import { cronMatches } from "./cron-match.js";
import { applyInOrder, eventSourceKey } from "./cursor-engine-order.js";
import {
  DEFAULT_TRIGGER_CATCH_UP_CAP,
  cursorIdentity,
  cursorSourceKind,
  readPendingBatch,
  registrationsFor,
  retentionKeysFor,
  scheduleExpr,
} from "./cursor-engine-support.js";
import type {
  CursorReadResult,
  CursorRegistration,
  CursorStore,
  LocalCursorScheduler,
  PendingFireBatch,
  TriggerCursorFireInput,
  VaultCursorEngineOptions,
} from "./cursor-engine-support.js";
import type { ReconcileResult } from "./host.js";
import { MemoryCursorStore } from "./memory-cursor-store.js";

export {
  DEFAULT_TRIGGER_CATCH_UP_CAP,
  assertTriggerCursorAllowed,
  isDeniedCursorEntity,
} from "./cursor-engine-support.js";
export type {
  CursorElement,
  CursorReadResult,
  CursorStore,
  LocalCursorScheduler,
  TriggerCursorFireInput,
  TriggerCursorReadInput,
  VaultCursorEngineOptions,
} from "./cursor-engine-support.js";

export class VaultCursorEngine implements LocalCursorScheduler {
  private readonly registrations = new Map<string, CursorRegistration>();
  private readonly fire: VaultCursorEngineOptions["fire"];
  private readonly fireCursor?: VaultCursorEngineOptions["fireCursor"];
  private readonly readCursor?: VaultCursorEngineOptions["readCursor"];
  private readonly evaluate?: VaultCursorEngineOptions["evaluate"];
  private readonly store: CursorStore;
  private readonly now: () => Date;
  private readonly onError?: VaultCursorEngineOptions["onError"];
  private readonly onTick?: VaultCursorEngineOptions["onTick"];
  private readonly onDormancyChange?: VaultCursorEngineOptions["onDormancyChange"];
  private readonly nudgeDelayMs: number;
  private readonly catchUpCap: number;
  private readonly defaultCronTimeZone?: () => string | undefined;
  private boundary?: ReturnType<typeof setTimeout>;
  private interval?: ReturnType<typeof setInterval>;
  private nudgeTimer?: ReturnType<typeof setTimeout>;
  private nudgeAll = false;
  private readonly nudgedEntities = new Set<string>();
  private lastProcessedMinute?: number;
  private readonly inFlight = new Map<
    string,
    { promise: Promise<void>; dirty: boolean }
  >();

  constructor(options: VaultCursorEngineOptions) {
    this.fire = options.fire;
    this.fireCursor = options.fireCursor;
    this.readCursor = options.readCursor;
    this.evaluate = options.evaluate;
    this.store = options.store ?? new MemoryCursorStore();
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError;
    this.onTick = options.onTick;
    this.defaultCronTimeZone = options.defaultCronTimeZone;
    this.onDormancyChange = options.onDormancyChange;
    this.nudgeDelayMs = options.nudgeDelayMs ?? 25;
    this.catchUpCap = options.catchUpCap ?? DEFAULT_TRIGGER_CATCH_UP_CAP;
  }

  async register(row: Row): Promise<void> {
    const wasDormant = this.registrations.size === 0;
    this.dropRegistrations(row.ref);
    if (row.enabled) {
      // Disabling drops registrations but deliberately keeps the stored
      // cursors: re-enabling resumes from the recorded position instead of
      // bootstrapping past everything that happened while it was off.
      for (const registration of registrationsFor(
        row,
        this.defaultCronTimeZone?.()
      )) {
        this.registrations.set(
          this.key(row.ref, registration.triggerIndex),
          registration
        );
      }
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
    return [
      ...new Set([...this.registrations.values()].map((entry) => entry.ref)),
    ].sort();
  }

  async reconcile(rows: ReadonlyArray<Row>): Promise<ReconcileResult> {
    const wasDormant = this.registrations.size === 0;
    const previous = new Map(this.registrations);
    const before = this.signatureByRef(previous);
    const next = new Map<string, CursorRegistration>();
    for (const row of rows) {
      // A disabled row is still validated: its triggers must stay legal for
      // the cursors that survive the disable.
      const registrations = registrationsFor(row, this.defaultCronTimeZone?.());
      if (!row.enabled) continue;
      for (const registration of registrations) {
        next.set(this.key(row.ref, registration.triggerIndex), registration);
      }
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
      await applyInOrder([...added, ...updated], (ref) =>
        this.bootstrapTriggers(ref, true)
      );
    } catch (error) {
      this.registrations.clear();
      for (const [key, value] of previous) this.registrations.set(key, value);
      throw error;
    }
    // Retention follows the DECLARED trigger slots of every desired row —
    // enabled or not. A disabled automation keeps its watermark, and an empty
    // desired set (a transient read of the app dir mid-swap) is a no-op rather
    // than a vault-wide wipe. Trigger slots that no longer exist are dropped
    // by (automation, index) so a shrunk trigger list cannot resurrect a stale
    // position at a reused index.
    const retained = retentionKeysFor(rows);
    if (retained.length > 0) this.store.deleteCursorsNotIn?.(retained);
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
      this.onError?.(error, "__scheduler");
    }
    for (const registration of this.registrations.values()) {
      const expr = scheduleExpr(registration.trigger);
      // A cron reader owns its whole (cursor, now] window. Processing it on
      // every wake-minute is what catches a 09:00 due instant when the host
      // resumes at 10:00; current-minute matching would defer it for a day.
      // Non-cron gated readers (condition/data/event) match their gate on
      // host-local wall clock — only pure cron triggers carry a zone.
      if (
        registration.trigger.kind === "cron" ||
        (expr !== undefined && cronMatches(expr, at))
      ) {
        this.processSafely(registration, at);
      }
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
        (trigger.kind === "webhook" &&
          "id" in trigger &&
          trigger.id === sourceKey) ||
        // An event source's durable ingress key is per-connection: the host
        // appends the bound `connectionId` and the trigger's filter hash onto
        // `eventSourceKey(trigger)` so a multi-account connector cannot deliver
        // account A's events to account B's automation. Match on that prefix
        // rather than the bare key, so a nudge always wakes the right
        // registration; a same-kind sibling that wakes too reads its own cursor
        // and finds nothing (#541 review).
        (trigger.kind === "event" &&
          sourceKey.startsWith(`${eventSourceKey(trigger)}:`));
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
    await Promise.allSettled(
      [...this.inFlight.values()].map((state) => state.promise)
    );
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
          trigger.kind === "data" &&
          (all || trigger.entities.some((entity) => entities.has(entity)));
        if (selected) this.processSafely(registration, at);
      }
    }, this.nudgeDelayMs);
    this.nudgeTimer.unref?.();
  }

  private processSafely(registration: CursorRegistration, at: Date): void {
    void this.serialize(registration, at).catch((error) =>
      this.onError?.(error, registration.ref)
    );
  }

  private serialize(registration: CursorRegistration, at: Date): Promise<void> {
    const key = this.key(registration.ref, registration.triggerIndex);
    const active = this.inFlight.get(key);
    if (active) {
      active.dirty = true;
      return active.promise;
    }
    const state: { readonly promise: Promise<void>; dirty: boolean } = {
      get promise(): Promise<void> {
        return promise;
      },
      dirty: false,
    };
    const promise = (async () => {
      let failure: { error: unknown } | undefined;
      const drainDirtyWork = async (): Promise<void> => {
        state.dirty = false;
        try {
          await this.process(registration, at);
        } catch (error) {
          // A doorbell rung DURING a failed batch still owes a delivery.
          // Webhook triggers are reached by neither `tick` nor `nudge`, so
          // dropping the flag here would strand the delivery until the next
          // POST or a restart. Drain it, then surface the first failure.
          failure ??= { error };
        }
        if (state.dirty) return drainDirtyWork();
        if (failure) throw failure.error;
      };
      await drainDirtyWork();
    })().finally(() => {
      if (this.inFlight.get(key) === state) this.inFlight.delete(key);
    });
    this.inFlight.set(key, state);
    return state.promise;
  }

  private async process(
    registration: CursorRegistration,
    at: Date
  ): Promise<void> {
    const storedCursor = this.store.getCursor(
      registration.ref,
      registration.triggerIndex
    );
    // If a trigger changed in place at the same array index, the previous
    // source position is meaningless to its replacement.
    const cursor =
      storedCursor?.sourceKind === cursorIdentity(registration.trigger)
        ? storedCursor
        : undefined;
    const priorPending = readPendingBatch(cursor?.pendingJson);
    let result: CursorReadResult;
    if (priorPending) {
      // A write-ahead batch is authoritative until it settles. Re-reading at
      // a later `now` could collapse cron to a newer due instant or let source
      // retention remove ingress payloads before restart delivery.
      result = {
        elements: priorPending.elements,
        ...(priorPending.targetPositionJson === undefined
          ? {}
          : { positionJson: priorPending.targetPositionJson }),
        skipped: priorPending.skipped,
        ...(priorPending.windowFrom === undefined
          ? {}
          : { windowFrom: priorPending.windowFrom }),
        ...(priorPending.windowTo === undefined
          ? {}
          : { windowTo: priorPending.windowTo }),
        ...(priorPending.gapReason === undefined
          ? {}
          : { gapReason: priorPending.gapReason }),
      };
    } else if (registration.trigger.kind === "cron") {
      const schedules = registration.cronSchedules ?? [
        { expr: registration.trigger.expr },
      ];
      result = readCronCursor(schedules, cursor, at);
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
    const identity = cursorIdentity(registration.trigger);
    const elements = result.elements.slice(0, this.catchUpCap);
    // INVARIANT: the committed position may never point past the last element
    // this batch actually delivers. A reader that over-returns keeps its
    // surplus for the next tick — cap overflow is durable data, not a gap.
    const overflowed = elements.length < result.elements.length;
    const targetPositionJson = overflowed
      ? (elements.at(-1)?.positionJson ?? cursor?.positionJson)
      : (result.positionJson ?? cursor?.positionJson);
    const acknowledged = new Set(priorPending?.acknowledged);
    const put = (pending?: PendingFireBatch): void => {
      this.store.putCursor({
        automationId: registration.ref,
        triggerIndex: registration.triggerIndex,
        sourceKind: identity,
        ...(pending
          ? cursor?.positionJson === undefined
            ? {}
            : { positionJson: cursor.positionJson }
          : targetPositionJson === undefined
            ? {}
            : { positionJson: targetPositionJson }),
        ...(pending ? { pendingJson: JSON.stringify(pending) } : {}),
        ...(result.windowFrom === undefined
          ? {}
          : { windowFrom: result.windowFrom }),
        ...(result.windowTo === undefined ? {} : { windowTo: result.windowTo }),
        skipped,
        ...(result.gapReason === undefined
          ? {}
          : { gapReason: result.gapReason }),
        updatedAt: at.getTime(),
      });
    };
    if (elements.length === 0) {
      // Nothing was delivered, so only a real state change earns a write. An
      // idle cron minute would otherwise upsert this row 1,440 times a day.
      const positionMoved =
        targetPositionJson !== undefined &&
        targetPositionJson !== cursor?.positionJson;
      const identityMoved =
        storedCursor !== undefined && storedCursor.sourceKind !== identity;
      if (
        positionMoved ||
        identityMoved ||
        storedCursor?.pendingJson !== undefined
      )
        put();
      return;
    }
    const pending = (): PendingFireBatch => ({
      ...(targetPositionJson === undefined ? {} : { targetPositionJson }),
      elements,
      acknowledged: [...acknowledged],
      skipped,
      ...(result.windowFrom === undefined
        ? {}
        : { windowFrom: result.windowFrom }),
      ...(result.windowTo === undefined ? {} : { windowTo: result.windowTo }),
      ...(result.gapReason === undefined
        ? {}
        : { gapReason: result.gapReason }),
    });
    // Durable intent precedes any side effect. The committed source position
    // deliberately stays unchanged until all terminal turns are receipted.
    put(pending());
    const deliverNext = async (index: number): Promise<void> => {
      const element = elements[index];
      if (element === undefined) return;
      if (acknowledged.has(element.position)) return deliverNext(index + 1);
      const fireInput: TriggerCursorFireInput = {
        automationRef: registration.ref,
        trigger: registration.trigger,
        triggerIndex: registration.triggerIndex,
        sourceKind: cursorSourceKind(registration.trigger),
        element,
        skipped,
        ...(result.windowFrom === undefined
          ? {}
          : { windowFrom: result.windowFrom }),
        ...(result.windowTo === undefined ? {} : { windowTo: result.windowTo }),
        ...(result.gapReason === undefined
          ? {}
          : { gapReason: result.gapReason }),
      };
      if (this.fireCursor) await this.fireCursor(fireInput);
      else if (registration.trigger.kind === "cron")
        await this.fire(registration.ref);
      acknowledged.add(element.position);
      put(pending());
      return deliverNext(index + 1);
    };
    await deliverNext(0);
    put();
  }

  private async bootstrapTriggers(
    ref: string,
    allowLegacyEvaluate: boolean
  ): Promise<void> {
    const canReadExternal =
      this.readCursor !== undefined ||
      (allowLegacyEvaluate && this.evaluate !== undefined);
    const at = this.now();
    const eligible = [...this.registrations.values()].filter(
      (registration) =>
        registration.ref === ref &&
        (registration.trigger.kind === "data" ||
          registration.trigger.kind === "webhook" ||
          registration.trigger.kind === "event")
    );
    await applyInOrder(eligible, async (registration) => {
      // Cron is deliberately absent: its window includes the current minute,
      // so bootstrapping it would run a `0 9 * * *` automation the instant it
      // is created (or re-enabled) at 09:00:30. Cron catches up on the next
      // tick instead — the same no-fire bootstrap data triggers get.
      if (!canReadExternal) return;
      try {
        await this.process(registration, at);
      } catch (error) {
        // Provider availability is not automation-definition readiness.
        // Keep an event trigger registered when its exact account is offline
        // or needs auth; the next cadence retries through the same cursor.
        // Data/condition bootstrap remains strict because its initial vault
        // position is part of install-time grant readiness.
        if (registration.trigger.kind !== "event") throw error;
        this.onError?.(error, registration.ref);
      }
    });
  }

  private dropRegistrations(ref: string): void {
    for (const [key, registration] of this.registrations) {
      if (registration.ref === ref) this.registrations.delete(key);
    }
  }

  private async notifyDormancy(wasDormant: boolean): Promise<void> {
    const dormant = this.registrations.size === 0;
    if (dormant === wasDormant || !this.onDormancyChange) return;
    try {
      await this.onDormancyChange(dormant, this.now());
    } catch (error) {
      // A dormancy ledger write is observability, not registration state. It
      // is surfaced, never swallowed, but it must not fail the reconcile that
      // just settled every automation.
      this.onError?.(error, "<scheduler-dormancy>");
    }
  }

  private key(ref: string, triggerIndex: number): string {
    return `${ref}\u0000${triggerIndex}`;
  }

  private signatureByRef(
    rows: ReadonlyMap<string, CursorRegistration>
  ): Map<string, string> {
    const grouped = new Map<
      string,
      Array<{
        index: number;
        trigger: Trigger;
        cronSchedules?: CursorRegistration["cronSchedules"];
      }>
    >();
    for (const registration of rows.values()) {
      const list = grouped.get(registration.ref) ?? [];
      list.push({
        index: registration.triggerIndex,
        trigger: registration.trigger,
        // Collapsed cron schedules + zones are part of the definition:
        // editing the second cron or its timezone must still read as "updated".
        ...(registration.cronSchedules
          ? { cronSchedules: registration.cronSchedules }
          : {}),
      });
      grouped.set(registration.ref, list);
    }
    return new Map(
      [...grouped].map(([ref, triggers]) => [
        ref,
        JSON.stringify(triggers.sort((a, b) => a.index - b.index)),
      ])
    );
  }
}

export { eventSourceKey } from "./cursor-engine-order.js";
