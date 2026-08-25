/*
 * CLOCK ADVERSITY against the automation scheduler (#842). The DST zoo
 * (`time-zoo-cron.test.ts`) attacks the CALENDAR and owns the fall-back Overlap
 * law; this attacks the DEVICE and the ENGINE. Three invariants: NO DOUBLE FIRE
 * (one zone wall-clock minute at most once, across ticks and devices), NO
 * SILENT SKIP (a swept due minute is delivered or counted in `skipped` with a
 * `gapReason`) and NO DRIFT (the committed position moves forward only, never
 * past the latest instant the clock showed).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AutomationTriggerCursor } from "@centraid/server/engine";
import { useFakeClock } from "@centraid/test-kit/fake-clock";
import { flushMacrotasks } from "@centraid/test-kit/flush";
import { seededRandom } from "@centraid/test-kit/random";
import { forEachSequentially } from "@centraid/test-kit/sequential";

import { wallClockMinuteKey } from "../cron-timezone.js";
import type { Manifest } from "../manifest/manifest.js";
import type { Row } from "../scaffold/app.js";
import { dueInstants, floorMinute, readCronCursor } from "./cron-cursor.js";
import { VaultCursorEngine } from "./cursor-engine.js";
import type {
  TriggerCursorFireInput,
  VaultCursorEngineOptions,
} from "./cursor-engine.js";
import { MemoryCursorStore } from "./memory-cursor-store.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const SCAN_HORIZON_MS = 44_640 * MINUTE;

const ADVERSITY_SEED = 842_033;

function automationRow(ref: string, expr: string, tz?: string): Row {
  const [ownerApp, id] = ref.split("/") as [string, string];
  const triggers: Manifest["triggers"] = [
    { kind: "cron", expr, ...(tz === undefined ? {} : { tz }) },
  ];
  const manifest: Manifest = {
    name: id,
    version: "0.1.0",
    enabled: true,
    prompt: "clock adversity",
    triggers,
    requires: {},
    history: { keep: "all" },
    generated: { by: "test", at: "2026-01-01T00:00:00.000Z" },
  };
  return {
    id,
    ownerApp,
    ref,
    name: id,
    dir: `/tmp/${id}`,
    enabled: true,
    triggers,
    manifest,
  };
}

interface Device {
  readonly engine: VaultCursorEngine;
  readonly fires: TriggerCursorFireInput[];
  at: number;
  tickAt: (instant: number) => Promise<void>;
}

function device(
  store: MemoryCursorStore,
  options: { readonly skewMs?: number } = {}
): Device {
  const skew = options.skewMs ?? 0;
  const fires: TriggerCursorFireInput[] = [];
  const state = { at: 0 };
  const engine = new VaultCursorEngine({
    store,
    now: () => new Date(state.at + skew),
    fire: vi.fn<VaultCursorEngineOptions["fire"]>(),
    fireCursor: (input) => {
      fires.push(input);
    },
  });
  return {
    engine,
    fires,
    get at(): number {
      return state.at;
    },
    set at(value: number) {
      state.at = value;
    },
    tickAt: async (instant: number) => {
      state.at = instant;
      engine.tick();
      // `processSafely` is fire-and-forget: a queue drain, not a sleep.
      await flushMacrotasks();
    },
  };
}

function firedKeys(
  fires: readonly TriggerCursorFireInput[],
  tz?: string
): string[] {
  return fires.map((fire) =>
    wallClockMinuteKey(new Date(fire.element.occurredAt), tz)
  );
}

function cursorAt(positionMs: number): AutomationTriggerCursor {
  return {
    automationId: "clock/one",
    triggerIndex: 0,
    sourceKind: "cron",
    positionJson: JSON.stringify(positionMs),
    skipped: 0,
    updatedAt: 0,
  };
}

function storedPosition(
  store: MemoryCursorStore,
  ref: string
): number | undefined {
  const raw = store.getCursor(ref, 0)?.positionJson;
  return raw === undefined ? undefined : Number(JSON.parse(raw));
}

describe("a device clock that steps", () => {
  beforeEach(() => {
    useFakeClock("2026-06-15T12:00:00.000Z", { toFake: ["Date"] });
  });

  it("delivers one fire and counts the rest when the clock jumps forward over due minutes", async () => {
    const store = new MemoryCursorStore();
    const ref = "clock/minutely";
    const dev = device(store);
    dev.at = Date.parse("2026-06-15T09:00:00.000Z");
    await dev.engine.register(automationRow(ref, "* * * * *", "Etc/UTC"));

    await dev.tickAt(Date.parse("2026-06-15T09:01:00.000Z"));
    expect(dev.fires).toHaveLength(1);

    await dev.tickAt(Date.parse("2026-06-15T09:10:00.000Z"));

    // NO SILENT SKIP: passed-over minutes are not backfilled (#149) but are
    // COUNTED, with a reason the member can be shown.
    expect(dev.fires).toHaveLength(2);
    const jump = dev.fires[1] as TriggerCursorFireInput;
    expect(new Date(jump.element.occurredAt).toISOString()).toBe(
      "2026-06-15T09:10:00.000Z"
    );
    expect(jump.skipped).toBe(8);
    expect(jump.gapReason).toBe("scheduler_gap");
    expect(storedPosition(store, ref)).toBe(
      Date.parse("2026-06-15T09:10:00.000Z")
    );
  });

  it("degrades the missed count to a floor beyond the 31-day scan horizon, never to a phantom", () => {
    // The backward scan is capped, so the COUNT degrades — in this direction.
    const to = Date.parse("2026-06-15T09:00:00.000Z");
    const stale = to - 90 * DAY;
    const result = readCronCursor(
      [{ expr: "0 9 * * *", timeZone: "Etc/UTC" }],
      cursorAt(stale),
      new Date(to)
    );

    const trueMissed = 89; // 09:00 on each of the 89 intervening days.
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]?.occurredAt).toBe(to);
    expect(result.skipped).toBeGreaterThan(0);
    expect(result.skipped).toBeLessThanOrEqual(trueMissed);
    expect(result.skipped).toBe(Math.floor(SCAN_HORIZON_MS / DAY) - 1);
  });

  it("fires nothing while the clock is rewound behind the committed position", async () => {
    // NTP correcting a fast clock: re-sweeping a rewound minute is the bug.
    const store = new MemoryCursorStore();
    const ref = "clock/minutely";
    const dev = device(store);
    dev.at = Date.parse("2026-06-15T09:00:00.000Z");
    await dev.engine.register(automationRow(ref, "* * * * *", "Etc/UTC"));

    await forEachSequentially([1, 2, 3, 4, 5], (n) =>
      dev.tickAt(Date.parse("2026-06-15T09:00:00.000Z") + n * MINUTE)
    );
    expect(dev.fires).toHaveLength(5);
    const committed = storedPosition(store, ref);
    expect(committed).toBe(Date.parse("2026-06-15T09:05:00.000Z"));

    await forEachSequentially([2, 3, 4, 5], (n) =>
      dev.tickAt(Date.parse("2026-06-15T09:00:00.000Z") + n * MINUTE)
    );

    expect(dev.fires).toHaveLength(5);
    // …and NO DRIFT: a dragged-back position reopens the next real minute.
    expect(storedPosition(store, ref)).toBe(committed);
  });

  it("resumes cleanly once a rewound clock passes its old position again", async () => {
    const store = new MemoryCursorStore();
    const ref = "clock/minutely";
    const dev = device(store);
    dev.at = Date.parse("2026-06-15T09:00:00.000Z");
    await dev.engine.register(automationRow(ref, "* * * * *", "Etc/UTC"));

    await dev.tickAt(Date.parse("2026-06-15T09:05:00.000Z"));
    await dev.tickAt(Date.parse("2026-06-15T09:02:00.000Z")); // rewind
    await dev.tickAt(Date.parse("2026-06-15T09:06:00.000Z")); // recover

    const delivered = dev.fires.map((fire) =>
      new Date(fire.element.occurredAt).toISOString()
    );
    expect(delivered).toStrictEqual([
      "2026-06-15T09:05:00.000Z",
      "2026-06-15T09:06:00.000Z",
    ]);
    expect((dev.fires[1] as TriggerCursorFireInput).skipped).toBe(0);
  });

  it("does not double-fire when ticks arrive slightly SHORT of a minute", async () => {
    // Wakeups at 59.9s see the same wall minute twice, which `floorMinute` and
    // the last-minute guard absorb.
    const store = new MemoryCursorStore();
    const ref = "clock/minutely";
    const dev = device(store);
    const start = Date.parse("2026-06-15T09:00:00.000Z");
    dev.at = start;
    await dev.engine.register(automationRow(ref, "* * * * *", "Etc/UTC"));

    const wakeups = Array.from(
      { length: 40 },
      (_unused, index) => start + (index + 1) * 59_900
    );
    await forEachSequentially(wakeups, (wakeup) => dev.tickAt(wakeup));

    const keys = firedKeys(dev.fires, "Etc/UTC");
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(40);
    expect(dev.fires.every((fire) => fire.skipped === 0)).toBe(true);
  });

  it("survives a seeded jitter walk without a repeat, a phantom, or a backward position", async () => {
    const store = new MemoryCursorStore();
    const ref = "clock/quarterly";
    const dev = device(store);
    const start = Date.parse("2026-06-15T00:00:00.000Z");
    dev.at = start;
    await dev.engine.register(
      automationRow(ref, "0,15,30,45 * * * *", "Etc/UTC")
    );

    const rng = seededRandom(ADVERSITY_SEED);
    let clock = start;
    const walk = Array.from({ length: 400 }, () => {
      const roll = rng.int(0, 99);
      const delta =
        roll < 70
          ? MINUTE
          : roll < 85
            ? rng.int(2, 40) * MINUTE // a stall or a sleep
            : roll < 95
              ? -rng.int(1, 30) * MINUTE // an NTP step back
              : rng.int(1, 6) * HOUR; // a big forward correction
      clock += delta;
      return clock;
    });
    const highWater = Math.max(...walk, start);
    const positions: number[] = [];
    await forEachSequentially(walk, async (instant) => {
      await dev.tickAt(instant);
      const position = storedPosition(store, ref);
      if (position !== undefined) positions.push(position);
    });

    const keys = firedKeys(dev.fires, "Etc/UTC");
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBeGreaterThan(20);
    const monotone = positions.every(
      (position, index) =>
        index === 0 || position >= (positions[index - 1] as number)
    );
    expect(monotone).toBe(true);
    expect(Math.max(...positions)).toBeLessThanOrEqual(floorMinute(highWater));
    const offSchedule = dev.fires.filter(
      (fire) => new Date(fire.element.occurredAt).getUTCMinutes() % 15 !== 0
    );
    expect(offSchedule).toStrictEqual([]);
  });
});

describe("two devices that disagree about now", () => {
  beforeEach(() => {
    useFakeClock("2026-06-15T12:00:00.000Z", { toFake: ["Date"] });
  });

  it("fires each due wall minute exactly once across a skewed pair sharing one cursor", async () => {
    // Two schedulers 90s apart over one cursor row. The window is half-open on
    // the committed position, so the pair must partition the minutes.
    const store = new MemoryCursorStore();
    const ref = "clock/quarterly";
    const expr = "0,15,30,45 * * * *";
    const ahead = device(store, { skewMs: 90_000 });
    const behind = device(store, { skewMs: -90_000 });
    const start = Date.parse("2026-06-15T10:00:00.000Z");
    ahead.at = start;
    behind.at = start;
    await ahead.engine.register(automationRow(ref, expr, "Etc/UTC"));
    await behind.engine.register(automationRow(ref, expr, "Etc/UTC"));

    const minutes = Array.from(
      { length: 120 },
      (_unused, index) => start + (index + 1) * MINUTE
    );
    await forEachSequentially(minutes, async (instant) => {
      await ahead.tickAt(instant);
      await behind.tickAt(instant);
    });

    const keys = firedKeys([...ahead.fires, ...behind.fires], "Etc/UTC");
    expect(new Set(keys).size).toBe(keys.length);
    const expected = dueInstants(
      [{ expr, timeZone: "Etc/UTC" }],
      new Date(start),
      new Date(start + 120 * MINUTE + 90_000)
    ).map((instant) => wallClockMinuteKey(instant, "Etc/UTC"));
    expect([...keys].sort()).toStrictEqual([...expected].sort());

    // THE LAW THIS PAIR STATES: the FURTHEST-AHEAD clock owns the schedule, so
    // the lagging device's window is inverted and it delivers nothing. Asserted
    // because a "let the lagging device sweep too" change would turn this exact
    // configuration into a double fire.
    expect(behind.fires).toStrictEqual([]);
    expect(ahead.fires.length).toBeGreaterThan(0);
  });

  it("hands the schedule to the lagging device when the leader stops, without a repeat or a hole", async () => {
    // Failover: the lagging device resumes from the SHARED committed position —
    // replaying is the double fire, waiting out its lag is the hole.
    const store = new MemoryCursorStore();
    const ref = "clock/quarterly";
    const expr = "0,15,30,45 * * * *";
    const leader = device(store, { skewMs: 90_000 });
    const follower = device(store, { skewMs: -90_000 });
    const start = Date.parse("2026-06-15T10:00:00.000Z");
    leader.at = start;
    follower.at = start;
    await leader.engine.register(automationRow(ref, expr, "Etc/UTC"));
    await follower.engine.register(automationRow(ref, expr, "Etc/UTC"));

    const HANDOVER = 61;
    const minutes = Array.from({ length: 180 }, (_unused, index) => index + 1);
    await forEachSequentially(minutes, async (n) => {
      const instant = start + n * MINUTE;
      if (n < HANDOVER) await leader.tickAt(instant);
      await follower.tickAt(instant);
    });
    await leader.engine.stop();

    const leaderKeys = firedKeys(leader.fires, "Etc/UTC");
    const followerKeys = firedKeys(follower.fires, "Etc/UTC");
    expect(leaderKeys.some((key) => followerKeys.includes(key))).toBe(false);
    const expected = dueInstants(
      [{ expr, timeZone: "Etc/UTC" }],
      new Date(start),
      new Date(start + 180 * MINUTE - 90_000)
    ).map((instant) => wallClockMinuteKey(instant, "Etc/UTC"));
    expect([...leaderKeys, ...followerKeys].sort()).toStrictEqual(
      [...expected].sort()
    );
    expect(leaderKeys.length).toBeGreaterThan(0);
    expect(followerKeys.length).toBeGreaterThan(0);
    const lastLed = Math.max(
      ...leader.fires.map((fire) => fire.element.occurredAt)
    );
    const firstFollowed = Math.min(
      ...follower.fires.map((fire) => fire.element.occurredAt)
    );
    expect(firstFollowed).toBeGreaterThan(lastLed);
  });
});

describe("a schedule whose timezone changes underneath it", () => {
  beforeEach(() => {
    useFakeClock("2026-06-15T12:00:00.000Z", { toFake: ["Date"] });
  });

  /**
   * The gateway default is re-read on every register/reconcile, and the cursor
   * stores an ABSOLUTE position — so a zone change moves the wall minute the
   * schedule matches while leaving the position where it was.
   */
  it("never re-delivers a wall minute already passed when the default zone moves west", async () => {
    const store = new MemoryCursorStore();
    const ref = "clock/daily";
    const zone = { value: "Etc/UTC" as string | undefined };
    const fires: TriggerCursorFireInput[] = [];
    const state = { at: Date.parse("2026-06-15T08:00:00.000Z") };
    const engine = new VaultCursorEngine({
      store,
      now: () => new Date(state.at),
      fire: vi.fn<VaultCursorEngineOptions["fire"]>(),
      fireCursor: (input) => {
        fires.push(input);
      },
      defaultCronTimeZone: () => zone.value,
    });
    const row = automationRow(ref, "0 9 * * *");
    await engine.register(row);

    const tick = async (iso: string): Promise<void> => {
      state.at = Date.parse(iso);
      engine.tick();
      await flushMacrotasks();
    };

    await tick("2026-06-15T09:00:00.000Z");
    expect(fires).toHaveLength(1);

    zone.value = "Etc/GMT+2"; // UTC−02:00
    await engine.register(row);

    // A DIFFERENT wall-clock minute: a new schedule, not a repeat.
    const afterNine = Array.from({ length: 180 }, (_unused, index) =>
      new Date(
        Date.parse("2026-06-15T09:00:00.000Z") + (index + 1) * MINUTE
      ).toISOString()
    );
    await forEachSequentially(afterNine, (iso) => tick(iso));
    expect(fires).toHaveLength(2);
    expect(
      new Date(
        (fires[1] as TriggerCursorFireInput).element.occurredAt
      ).toISOString()
    ).toBe("2026-06-15T11:00:00.000Z");
    // NO DOUBLE FIRE where it is meaningful: no ABSOLUTE minute twice.
    expect(new Set(fires.map((fire) => fire.element.occurredAt)).size).toBe(2);
    expect(
      wallClockMinuteKey(new Date(fires[0]!.element.occurredAt), "Etc/UTC")
    ).not.toBe(
      wallClockMinuteKey(new Date(fires[1]!.element.occurredAt), "Etc/GMT+2")
    );
    expect((fires[1] as TriggerCursorFireInput).skipped).toBe(0);
    expect((fires[1] as TriggerCursorFireInput).gapReason).toBeUndefined();
  });

  it("skips the day rather than back-firing when the zone moves east past the committed position", async () => {
    // The mirror case: the half-open window refuses a new zone's 09:00 that has
    // already passed, which a re-derived "last matching minute" would fire.
    const store = new MemoryCursorStore();
    const ref = "clock/daily";
    const committed = Date.parse("2026-06-15T09:00:00.000Z");
    store.putCursor({
      automationId: ref,
      triggerIndex: 0,
      sourceKind: "cron",
      positionJson: JSON.stringify(committed),
      updatedAt: committed,
    });

    const sameDay = readCronCursor(
      [{ expr: "0 9 * * *", timeZone: "Asia/Kolkata" }],
      cursorAt(committed),
      new Date("2026-06-15T23:59:00.000Z")
    );
    expect(sameDay.elements).toStrictEqual([]);
    expect(sameDay.skipped).toBe(0);

    const nextDay = readCronCursor(
      [{ expr: "0 9 * * *", timeZone: "Asia/Kolkata" }],
      cursorAt(Date.parse("2026-06-15T23:59:00.000Z")),
      new Date("2026-06-16T23:59:00.000Z")
    );
    expect(
      nextDay.elements.map((element) =>
        new Date(element.occurredAt).toISOString()
      )
    ).toStrictEqual(["2026-06-16T03:30:00.000Z"]);
    expect(nextDay.skipped).toBe(0);
  });

  it("dedupes per schedule zone when two triggers on one automation disagree about the zone", () => {
    // `dueInstants` dedupes per matching schedule's zone, so two zones naming
    // one absolute minute must still be one due instant.
    const shared = dueInstants(
      [
        { expr: "0 9 * * *", timeZone: "Etc/UTC" },
        { expr: "30 14 * * *", timeZone: "Asia/Kolkata" }, // 09:00 UTC
      ],
      new Date("2026-06-15T00:00:00.000Z"),
      new Date("2026-06-15T23:59:00.000Z")
    );
    expect(shared.map((instant) => instant.toISOString())).toStrictEqual([
      "2026-06-15T09:00:00.000Z",
    ]);
  });
});
