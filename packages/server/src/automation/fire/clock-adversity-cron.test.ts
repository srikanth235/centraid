/*
 * CLOCK ADVERSITY against the automation scheduler (#842).
 *
 * The DST zoo (`time-zoo-cron.test.ts`, #839) attacks the CALENDAR: it holds
 * the device clock honest and varies the zone's own irregularities. This file
 * attacks the DEVICE, and it attacks the ENGINE rather than the matcher: the
 * clock steps forward, steps backward, ticks slightly short of a minute, gets
 * its schedule's timezone rewritten underneath it, and — the case a single
 * process cannot express at all — two schedulers disagree about what time it
 * is while sharing one cursor row.
 *
 * Nothing here re-states the fall-back Overlap law. That law, and the pinned
 * defect standing against that law — docs/decisions.md **A-pinned**, the
 * fall-back double fire against docs/cron-timezone.md § "DST policy" — stay
 * owned by
 * time-zoo-cron.test.ts. What this file adds is the SAME family of question —
 * can a wall-clock minute be delivered twice, or vanish? — asked of the faults
 * that have nothing to do with tzdata.
 *
 * The three invariants every case below is stated in terms of:
 *
 *   NO DOUBLE FIRE  — one zone wall-clock minute is delivered at most once,
 *                     across every tick and across every device.
 *   NO SILENT SKIP  — a due minute the scheduler swept is either delivered or
 *                     counted in `skipped` with a `gapReason`; it never simply
 *                     disappears.
 *   NO DRIFT        — the committed position moves monotonically forward and
 *                     never past the latest instant the clock actually showed.
 *
 * Everything runs on `useFakeClock` plus the engine's injected `now` seam, so
 * no assertion here can read a real wall clock.
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

/** `cron-cursor.ts` MAX_SCAN_MINUTES, restated so a horizon claim is explicit. */
const SCAN_HORIZON_MS = 44_640 * MINUTE;

/** Seeded so the jitter walk varies while any failure replays from its output. */
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

/** One scheduler over a shared store, with a clock the test moves by hand. */
interface Device {
  readonly engine: VaultCursorEngine;
  readonly fires: TriggerCursorFireInput[];
  /** Absolute instant this device believes it is; the test writes it. */
  at: number;
  /** Advance this device's belief and let it process one tick. */
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
      // `tick` dispatches through `processSafely`, which is fire-and-forget by
      // design; the delivery is only observable after its promise chain
      // settles. This is a queue drain, not a sleep — see `flushMacrotasks`.
      await flushMacrotasks();
    },
  };
}

/** Distinct zone wall-clock keys across a device's whole fire log. */
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

/** Position the store holds for the single automation these tests register. */
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
    // A laptop resuming from sleep: the clock is CORRECT again, it just moved
    // in one step. Nine 09:0x fires became due while it slept.
    const store = new MemoryCursorStore();
    const ref = "clock/minutely";
    const dev = device(store);
    dev.at = Date.parse("2026-06-15T09:00:00.000Z");
    await dev.engine.register(automationRow(ref, "* * * * *", "Etc/UTC"));

    await dev.tickAt(Date.parse("2026-06-15T09:01:00.000Z"));
    expect(dev.fires).toHaveLength(1);

    await dev.tickAt(Date.parse("2026-06-15T09:10:00.000Z"));

    // NO SILENT SKIP: the nine minutes the jump passed over are not delivered
    // (the scheduler does not backfill, #149) but they are COUNTED, and the
    // count carries a reason the member can be shown.
    expect(dev.fires).toHaveLength(2);
    const jump = dev.fires[1] as TriggerCursorFireInput;
    expect(new Date(jump.element.occurredAt).toISOString()).toBe(
      "2026-06-15T09:10:00.000Z"
    );
    expect(jump.skipped).toBe(8);
    expect(jump.gapReason).toBe("scheduler_gap");
    // NO DRIFT: the position lands on the instant the clock showed, not past it.
    expect(storedPosition(store, ref)).toBe(
      Date.parse("2026-06-15T09:10:00.000Z")
    );
  });

  it("degrades the missed count to a floor beyond the 31-day scan horizon, never to a phantom", () => {
    // A cursor restored from an old backup. cron-cursor.ts caps the backward
    // scan at MAX_SCAN_MINUTES so a tick cannot walk a year of minutes
    // synchronously; the documented consequence is that the COUNT degrades —
    // and the direction of the degradation is the whole point.
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
    // The horizon, not an arbitrary number, is what bounds it: 31 days of
    // daily fires minus the one delivered.
    expect(result.skipped).toBe(Math.floor(SCAN_HORIZON_MS / DAY) - 1);
  });

  it("fires nothing while the clock is rewound behind the committed position", async () => {
    // NTP correcting a clock that had run fast. Every minute in the rewound
    // span was already swept once; sweeping it again is the double fire.
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

    // Rewind three minutes and re-tick every minute the rewind re-crosses.
    await forEachSequentially([2, 3, 4, 5], (n) =>
      dev.tickAt(Date.parse("2026-06-15T09:00:00.000Z") + n * MINUTE)
    );

    // NO DOUBLE FIRE: not one of the re-crossed minutes is delivered again…
    expect(dev.fires).toHaveLength(5);
    // …and NO DRIFT: the rewind does not drag the committed position backward,
    // which is what would make the next real minute look like a fresh window.
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
    // The recovery window is (09:05, 09:06] — the rewind did not turn it into
    // a four-minute catch-up, so no phantom missed run is reported.
    expect((dev.fires[1] as TriggerCursorFireInput).skipped).toBe(0);
  });

  it("does not double-fire when ticks arrive slightly SHORT of a minute", async () => {
    // A drifting monotonic timer (and the shape a leap-second smear produces):
    // wakeups land at 59.9s intervals, so the same wall minute is observed
    // twice in a row. `floorMinute` plus the engine's last-processed-minute
    // guard are what must absorb it.
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
    // 40 wakeups at 59.9s cover the 40 wall minutes 09:00…09:39 — each read
    // twice by some pair of adjacent wakeups, each delivered ONCE.
    expect(keys).toHaveLength(40);
    expect(dev.fires.every((fire) => fire.skipped === 0)).toBe(true);
  });

  it("survives a seeded jitter walk without a repeat, a phantom, or a backward position", async () => {
    // The generator the hand-written cases above cannot be: a day of wakeups
    // whose deltas are mostly a minute but occasionally a stall, a sleep, or a
    // correction in either direction.
    const store = new MemoryCursorStore();
    const ref = "clock/quarterly";
    const dev = device(store);
    const start = Date.parse("2026-06-15T00:00:00.000Z");
    dev.at = start;
    await dev.engine.register(
      automationRow(ref, "0,15,30,45 * * * *", "Etc/UTC")
    );

    // The whole walk is drawn UP FRONT so the corpus is a value the failure
    // output can be replayed from, and so the ticks are a sequence rather than
    // a loop that interleaves generation with I/O.
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

    // NO DOUBLE FIRE across the whole walk.
    const keys = firedKeys(dev.fires, "Etc/UTC");
    expect(new Set(keys).size).toBe(keys.length);
    // The walk is only meaningful if it actually delivered a corpus.
    expect(keys.length).toBeGreaterThan(20);
    // NO DRIFT, twice over: the committed position never moves backward…
    const monotone = positions.every(
      (position, index) =>
        index === 0 || position >= (positions[index - 1] as number)
    );
    expect(monotone).toBe(true);
    // …and never points past the furthest instant the clock ever showed.
    expect(Math.max(...positions)).toBeLessThanOrEqual(floorMinute(highWater));
    // Every delivered instant is a real match of the schedule — a corrected
    // clock must never manufacture a fire on a minute the expression excludes.
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
    // One vault, one cursor row, two schedulers whose clocks are 90 seconds
    // apart — the shape a resident desktop plus a second host produces, and
    // the one a single-process test cannot express at all. The window is
    // half-open on the committed position, so the pair must partition the
    // minutes between them rather than both claiming any.
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
    // NO DOUBLE FIRE across the pair: the union of both logs has no repeat.
    expect(new Set(keys).size).toBe(keys.length);
    // NO SILENT SKIP: every quarter-hour the pair swept is present exactly
    // once, wherever it was delivered from.
    const expected = dueInstants(
      [{ expr, timeZone: "Etc/UTC" }],
      new Date(start),
      new Date(start + 120 * MINUTE + 90_000)
    ).map((instant) => wallClockMinuteKey(instant, "Etc/UTC"));
    expect([...keys].sort()).toStrictEqual([...expected].sort());

    // THE LAW THIS PAIR ACTUALLY STATES: the FURTHEST-AHEAD clock owns the
    // schedule. The lagging device's window is inverted (`from` > `to`) on
    // every tick, which reads as nothing due — so it never re-delivers what
    // the leader already committed, and never delivers anything of its own.
    // Asserted rather than shrugged at, because the member-visible
    // consequence is real (a skewed host fires everything 90s early) and
    // because a future "let the lagging device sweep too" change would turn
    // this exact configuration into a double fire.
    expect(behind.fires).toStrictEqual([]);
    expect(ahead.fires.length).toBeGreaterThan(0);
  });

  it("hands the schedule to the lagging device when the leader stops, without a repeat or a hole", async () => {
    // The failover the law above makes necessary: the ahead device is the one
    // firing everything, so what happens when it goes away is not a detail.
    // The lagging device must resume from the SHARED committed position —
    // re-delivering the leader's last minutes would be the double fire, and
    // waiting out its own lag before starting would be the hole.
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
      // The leader is unplugged at the handover minute and never ticks again.
      if (n < HANDOVER) await leader.tickAt(instant);
      await follower.tickAt(instant);
    });
    await leader.engine.stop();

    const leaderKeys = firedKeys(leader.fires, "Etc/UTC");
    const followerKeys = firedKeys(follower.fires, "Etc/UTC");
    // NO DOUBLE FIRE across the handover: the two logs are disjoint.
    expect(leaderKeys.some((key) => followerKeys.includes(key))).toBe(false);
    // NO SILENT SKIP: the union is still every quarter-hour of the span.
    const expected = dueInstants(
      [{ expr, timeZone: "Etc/UTC" }],
      new Date(start),
      new Date(start + 180 * MINUTE - 90_000)
    ).map((instant) => wallClockMinuteKey(instant, "Etc/UTC"));
    expect([...leaderKeys, ...followerKeys].sort()).toStrictEqual(
      [...expected].sort()
    );
    // Both halves of the handover happened — a green from an empty follower
    // would prove nothing about failover.
    expect(leaderKeys.length).toBeGreaterThan(0);
    expect(followerKeys.length).toBeGreaterThan(0);
    // The follower picks up where the leader stopped rather than replaying it:
    // its first delivery is strictly later than the leader's last.
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
   * The gateway-wide default (docs/cron-timezone.md, tier 2) is read on every
   * register/reconcile, so a Settings change re-resolves the zone without a
   * restart. The cursor row survives that re-resolution — it stores an
   * absolute millisecond position, which means the change moves the WALL
   * MINUTE the schedule matches while leaving the position where it was.
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

    // Fires at 09:00 UTC.
    await tick("2026-06-15T09:00:00.000Z");
    expect(fires).toHaveLength(1);

    // The member moves the gateway default two hours west; re-registering is
    // what a Settings write does.
    zone.value = "Etc/GMT+2"; // UTC−02:00
    await engine.register(row);

    // 09:00 in the new zone is 11:00 UTC — later today. It fires, and it is a
    // DIFFERENT wall-clock minute, so this is the new schedule rather than a
    // repeat of the old one.
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
    // NO DOUBLE FIRE, stated where it is meaningful: no ABSOLUTE minute is
    // delivered twice, and the two deliveries are two distinct civil minutes
    // in the zone each was scheduled under.
    expect(new Set(fires.map((fire) => fire.element.occurredAt)).size).toBe(2);
    expect(
      wallClockMinuteKey(new Date(fires[0]!.element.occurredAt), "Etc/UTC")
    ).not.toBe(
      wallClockMinuteKey(new Date(fires[1]!.element.occurredAt), "Etc/GMT+2")
    );
    // NO PHANTOM MISS: a zone change is not a scheduler gap.
    expect((fires[1] as TriggerCursorFireInput).skipped).toBe(0);
    expect((fires[1] as TriggerCursorFireInput).gapReason).toBeUndefined();
  });

  it("skips the day rather than back-firing when the zone moves east past the committed position", async () => {
    // The mirror case: the new zone's 09:00 already happened this morning. The
    // half-open window is what refuses it — a scheduler that re-derived "the
    // last matching minute" without consulting the cursor would fire an
    // automation for a time that is already in the past.
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

    // 09:00 in Asia/Kolkata (+05:30) is 03:30 UTC — behind the position.
    const sameDay = readCronCursor(
      [{ expr: "0 9 * * *", timeZone: "Asia/Kolkata" }],
      cursorAt(committed),
      new Date("2026-06-15T23:59:00.000Z")
    );
    expect(sameDay.elements).toStrictEqual([]);
    expect(sameDay.skipped).toBe(0);

    // Tomorrow's 03:30 UTC is delivered normally, exactly once.
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
    // One automation, two cron triggers, two zones that name the SAME absolute
    // minute. `dueInstants` keys its dedupe per matching schedule's zone, so
    // the shared instant must still be one due instant, not two.
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
