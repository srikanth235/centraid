import { describe, expect, it } from "vitest";

import {
  alertNotification,
  applyState,
  clampAlertSeconds,
  DEFAULT_ALERT_SECONDS,
  durabilitySentence,
  evaluateAlerts,
  formatDurationMs,
  initialMonitorState,
  MAX_ALERT_SECONDS,
  MIN_ALERT_SECONDS,
  readState,
} from "./seat-state-core.js";
import type { SeatState } from "./seat-state-core.js";

const settled = (overrides: Partial<SeatState> = {}): SeatState => ({
  availability: "local",
  durability: "settled",
  pending_work: { outbox: 0, behind: 0, stalled: false },
  connectivity: "online",
  mode: "replicated",
  at_ms: 0,
  ...overrides,
});

describe("the read state", () => {
  it("is `starting` before anything has arrived — never an empty list", () => {
    expect(readState(undefined)).toStrictEqual({ kind: "starting" });
  });

  it("is readable and not stale for a settled online replicated seat", () => {
    expect(readState(settled())).toStrictEqual({
      kind: "readable",
      stale: false,
    });
  });

  it("stays readable but stale when a replicated seat goes offline", () => {
    expect(
      readState(settled({ connectivity: "offline", durability: "local-only" }))
    ).toStrictEqual({ kind: "readable", stale: true });
  });

  it("is stale while the seat is catching up, even online", () => {
    expect(
      readState(
        settled({ pending_work: { outbox: 0, behind: 900, stalled: true } })
      ).kind
    ).toBe("readable");
    expect(
      (
        readState(
          settled({ pending_work: { outbox: 0, behind: 900, stalled: true } })
        ) as { stale: boolean }
      ).stale
    ).toBe(true);
  });

  /** The law: a thin seat with no gateway shows nothing-to-show, not zero rows. */
  it("is `nothing-to-show` with a reason for a thin seat that lost its gateway", () => {
    const read = readState(
      settled({
        mode: "thin",
        availability: "unavailable",
        durability: "none",
        connectivity: "offline",
      })
    );
    expect(read.kind).toBe("nothing-to-show");
    expect((read as { reason: string }).reason).toMatch(/cannot be reached/u);
    expect((read as { reason: string }).reason).not.toMatch(/empty/u);
  });

  it("says `not paired yet` on first run rather than blaming the network", () => {
    const read = readState(
      settled({ availability: "unavailable", connectivity: "unconfigured" })
    );
    expect((read as { reason: string }).reason).toMatch(/not been paired/u);
  });

  it("says the local copy is missing for a replicated seat with no file", () => {
    const read = readState(
      settled({ availability: "unavailable", connectivity: "offline" })
    );
    expect((read as { reason: string }).reason).toMatch(/no local copy/u);
  });
});

describe("the durability sentence", () => {
  it("differs for every durability, and counts the outbox when it can", () => {
    expect(durabilitySentence(settled())).toMatch(/on the gateway/u);
    expect(
      durabilitySentence(
        settled({
          durability: "local-only",
          pending_work: { outbox: 1, behind: 0, stalled: false },
        })
      )
    ).toBe("1 change is saved here and not yet on the gateway.");
    expect(
      durabilitySentence(
        settled({
          durability: "local-only",
          pending_work: { outbox: 4, behind: 0, stalled: false },
        })
      )
    ).toBe("4 changes are saved here and not yet on the gateway.");
    expect(
      durabilitySentence(
        settled({
          durability: "local-only",
          pending_work: { outbox: 0, behind: 0, stalled: false },
        })
      )
    ).toMatch(/not yet confirmed/u);
    expect(durabilitySentence(settled({ durability: "none" }))).toMatch(
      /no copy/u
    );
  });
});

describe("the monitor", () => {
  const config = { enabled: true, thresholdSeconds: DEFAULT_ALERT_SECONDS };

  /**
   * #647, in the shape a push gives it: the first state must not open an
   * outage, or every launch emits a durable down/recovered pair.
   */
  it("does not open an outage on the first state, even when it is offline", () => {
    const monitor = applyState(
      initialMonitorState(),
      settled({ connectivity: "offline", at_ms: 1000 })
    );
    expect(monitor.outages).toHaveLength(0);
    const { alerts } = evaluateAlerts(monitor, config, 1_000_000);
    expect(alerts).toHaveLength(0);
  });

  it("opens one outage on the transition and closes it on recovery", () => {
    let monitor = applyState(initialMonitorState(), settled({ at_ms: 0 }));
    monitor = applyState(
      monitor,
      settled({ connectivity: "offline", at_ms: 1000 })
    );
    expect(monitor.outages).toHaveLength(1);
    // A second offline state does NOT open a second outage.
    monitor = applyState(
      monitor,
      settled({ connectivity: "offline", at_ms: 2000 })
    );
    expect(monitor.outages).toHaveLength(1);
    monitor = applyState(monitor, settled({ at_ms: 3000 }));
    expect(monitor.outages[0]?.endedAt).toBe(3000);
  });

  it("fires down once, only past the threshold, and pairs a recovery with it", () => {
    let monitor = applyState(initialMonitorState(), settled({ at_ms: 0 }));
    monitor = applyState(
      monitor,
      settled({ connectivity: "offline", at_ms: 1000 })
    );

    // Before the threshold: nothing.
    let evaluated = evaluateAlerts(monitor, config, 1000 + 10_000);
    expect(evaluated.alerts).toHaveLength(0);

    evaluated = evaluateAlerts(
      evaluated.monitor,
      config,
      1000 + config.thresholdSeconds * 1000
    );
    expect(evaluated.alerts).toStrictEqual([
      { kind: "down", downForMs: config.thresholdSeconds * 1000 },
    ]);
    // ONCE, EVER.
    expect(
      evaluateAlerts(evaluated.monitor, config, 1_000_000).alerts
    ).toHaveLength(0);

    const back = applyState(evaluated.monitor, settled({ at_ms: 500_000 }));
    const recovered = evaluateAlerts(back, config, 500_001);
    expect(recovered.alerts).toStrictEqual([
      { kind: "recovered", outageMs: 500_000 - 1000 },
    ]);
    expect(
      evaluateAlerts(recovered.monitor, config, 600_000).alerts
    ).toHaveLength(0);
  });

  it("never fires a recovery for an outage nobody was told about", () => {
    let monitor = applyState(initialMonitorState(), settled({ at_ms: 0 }));
    monitor = applyState(
      monitor,
      settled({ connectivity: "offline", at_ms: 1000 })
    );
    // Recovered inside the threshold, so `down` never fired.
    monitor = applyState(monitor, settled({ at_ms: 2000 }));
    expect(evaluateAlerts(monitor, config, 2001).alerts).toHaveLength(0);
  });

  it("fires nothing at all when alerts are off, and the recovery still pairs later", () => {
    let monitor = applyState(initialMonitorState(), settled({ at_ms: 0 }));
    monitor = applyState(
      monitor,
      settled({ connectivity: "offline", at_ms: 1000 })
    );
    const off = evaluateAlerts(
      monitor,
      { enabled: false, thresholdSeconds: 1 },
      500_000
    );
    expect(off.alerts).toHaveLength(0);
    // The outage was never marked, so turning alerts back on still fires it.
    const on = evaluateAlerts(off.monitor, config, 500_000);
    expect(on.alerts.map((alert) => alert.kind)).toStrictEqual(["down"]);
  });

  it("fires a stall once and re-arms it after the seat catches up", () => {
    let monitor = applyState(initialMonitorState(), settled({ at_ms: 0 }));
    monitor = applyState(
      monitor,
      settled({
        at_ms: 1000,
        pending_work: { outbox: 0, behind: 5, stalled: true },
      })
    );
    let evaluated = evaluateAlerts(monitor, config, 1000);
    expect(evaluated.alerts).toStrictEqual([{ kind: "stalled" }]);
    expect(evaluateAlerts(evaluated.monitor, config, 2000).alerts).toHaveLength(
      0
    );

    const caught = applyState(evaluated.monitor, settled({ at_ms: 3000 }));
    expect(caught.stalledSince).toBeUndefined();
    const again = applyState(
      caught,
      settled({
        at_ms: 4000,
        pending_work: { outbox: 0, behind: 9, stalled: true },
      })
    );
    evaluated = evaluateAlerts(again, config, 4000);
    expect(evaluated.alerts).toStrictEqual([{ kind: "stalled" }]);
  });
});

describe("the alert threshold and its copy", () => {
  it("clamps a number and drops garbage", () => {
    expect(clampAlertSeconds(60)).toBe(60);
    expect(clampAlertSeconds(1)).toBe(MIN_ALERT_SECONDS);
    expect(clampAlertSeconds(10_000)).toBe(MAX_ALERT_SECONDS);
    expect(clampAlertSeconds(59.6)).toBe(60);
    for (const bad of [
      "60",
      null,
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      {},
    ]) {
      expect(clampAlertSeconds(bad)).toBeUndefined();
    }
  });

  it("formats a duration the four ways v0 does", () => {
    expect(formatDurationMs(47_000)).toBe("47s");
    expect(formatDurationMs(200_000)).toBe("3m 20s");
    expect(formatDurationMs(7_500_000)).toBe("2h 05m");
    expect(formatDurationMs(101_000_000)).toBe("1d 4h");
    expect(formatDurationMs(-5)).toBe("0s");
  });

  it("gives every alert its own title and body, and quotes the crash loop", () => {
    const kinds = [
      { kind: "down", downForMs: 120_000 },
      { kind: "recovered", outageMs: 120_000 },
      {
        kind: "crash-loop",
        message: "The Centraid seat process failed 3 times",
      },
      { kind: "stalled" },
      { kind: "unstalled" },
    ] as const;
    const titles = new Set<string>();
    for (const alert of kinds) {
      const notification = alertNotification(alert);
      expect(notification.body).not.toBe("");
      titles.add(notification.title);
    }
    expect(titles.size).toBe(kinds.length);
    expect(
      alertNotification({
        kind: "crash-loop",
        message: "The Centraid seat process failed 3 times",
      }).body
    ).toBe("The Centraid seat process failed 3 times");
    // The down notice tells the member what happens to their writes, which is
    // the only thing they can act on.
    expect(alertNotification({ kind: "down", downForMs: 1000 }).body).toMatch(
      /saved here/u
    );
  });
});
