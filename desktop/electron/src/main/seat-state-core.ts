/*
 * The four states, as the shell reads them (#1020, D-1020-F4). No `electron`.
 *
 * The sidecar folds facts into a `SeatState`; this module turns a stream of
 * those into (a) the **read state** every list screen must draw and (b) the
 * **notifications** main fires. Both halves are ported in spirit from v0's
 * `gateway-monitor-core.ts`, and the reasons the v0 file gives are the reasons
 * the shapes are kept:
 *
 * - Alerts live in MAIN, not the renderer, so they survive navigation and fire
 *   while backgrounded (`gateway-monitor.ts:1`–`:8`).
 * - An outage fires **once, ever**, and its recovery notice pairs with an
 *   already-fired down alert (`evaluateAlert`).
 * - Boot-phase noise is **not folded into tracking at all** (#647): folding it
 *   would open an outage and emit a durable down/recovered pair. Leaving the
 *   state untouched makes that pair vanish by construction — "do not swap this
 *   for a 'was suppressed' flag".
 *
 * What is NOT ported is the 5 s health poll and everything downstream of it
 * (latency degradation, component alerts, version skew). The seat *tells* the
 * shell its state; a poll would be a second source of truth for something the
 * writer already said, and `crates/centraid/src/cmd/seat/state.rs` explains why
 * durability and pending work cannot come from a poll at all.
 */

export type Availability = "local" | "forwarded" | "unavailable";
export type Durability = "settled" | "local-only" | "none";
export type Connectivity = "online" | "offline" | "unconfigured";

export interface PendingWork {
  outbox: number;
  behind: number;
  stalled: boolean;
}

/** Exactly the sidecar's `SeatStateJson`. */
export interface SeatState {
  availability: Availability;
  durability: Durability;
  pending_work: PendingWork;
  connectivity: Connectivity;
  mode: "replicated" | "thin";
  at_ms: number;
}

/**
 * THE THREE-STATE READ LAW, as a type.
 *
 * A list screen has three answers and not two: loading, "nothing to show", and
 * rows. An `empty` that means "the vault has nothing" and an `unavailable` that
 * means "I cannot see the vault" are different screens, and conflating them is
 * how a seat that lost its gateway tells the member their vault is empty.
 */
export type ReadState =
  | { kind: "starting" }
  | { kind: "readable"; stale: boolean }
  | { kind: "nothing-to-show"; reason: string };

export function readState(state: SeatState | undefined): ReadState {
  if (!state) return { kind: "starting" };
  if (state.availability === "unavailable") {
    return {
      kind: "nothing-to-show",
      reason:
        state.connectivity === "unconfigured"
          ? "This seat has not been paired to a vault yet."
          : state.mode === "thin"
            ? "This is a thin seat and its gateway cannot be reached, so there is nothing to show yet."
            : "This seat has no local copy of the vault yet.",
    };
  }
  // A replicated seat that is offline still READS — that is the whole reason
  // it exists — and what the screen must say is that what it shows may be
  // behind, not that there is nothing.
  return {
    kind: "readable",
    stale: state.connectivity !== "online" || state.pending_work.stalled,
  };
}

/** The one line the shell shows about durability. */
export function durabilitySentence(state: SeatState): string {
  switch (state.durability) {
    case "settled":
      return "Everything you have written is on the gateway.";
    case "local-only":
      return state.pending_work.outbox > 0
        ? `${state.pending_work.outbox} ${
            state.pending_work.outbox === 1 ? "change is" : "changes are"
          } saved here and not yet on the gateway.`
        : "Your changes are saved here and not yet confirmed by the gateway.";
    case "none":
      return "This seat keeps no copy: every change goes straight to the gateway.";
  }
}

/** A notification main should fire. */
export type SeatAlert =
  | { kind: "down"; downForMs: number }
  | { kind: "recovered"; outageMs: number }
  | { kind: "crash-loop"; message: string }
  | { kind: "stalled" }
  | { kind: "unstalled" };

export interface AlertConfig {
  enabled: boolean;
  thresholdSeconds: number;
}

export const DEFAULT_ALERT_SECONDS = 120;
export const MIN_ALERT_SECONDS = 15;
export const MAX_ALERT_SECONDS = 3600;

/** `undefined` for non-numeric garbage, so the field is dropped. v0's rule. */
export function clampAlertSeconds(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return Math.min(
    MAX_ALERT_SECONDS,
    Math.max(MIN_ALERT_SECONDS, Math.round(raw))
  );
}

interface Outage {
  startedAt: number;
  endedAt?: number;
  /** Fires once, ever, per outage. */
  alertedAt?: number;
  recoveredNoticeAt?: number;
}

export interface MonitorState {
  /** `undefined` until the first state arrives: boot phase. */
  last?: SeatState;
  outages: Outage[];
  stalledSince?: number;
  stalledAlerted: boolean;
}

export const OUTAGE_CAP = 50;

export function initialMonitorState(): MonitorState {
  return { outages: [], stalledAlerted: false };
}

/**
 * Fold one state in. Pure — returns a new state.
 *
 * Boot phase: the FIRST state to arrive never opens an outage even when it
 * says offline, because "not started yet" is not an outage. v0's
 * `isPendingBootProbe`, in the shape a push gives it: there is no synthesised
 * probe to flag, so the condition is simply "nothing has arrived before".
 */
export function applyState(
  monitor: MonitorState,
  state: SeatState
): MonitorState {
  const wasOnline = monitor.last?.connectivity === "online";
  const isOnline = state.connectivity === "online";
  const booting = monitor.last === undefined;
  let outages = monitor.outages;
  if (!booting && !isOnline && wasOnline) {
    outages = [...outages, { startedAt: state.at_ms }].slice(-OUTAGE_CAP);
  } else if (!booting && isOnline && !wasOnline) {
    const last = outages[outages.length - 1];
    if (last && last.endedAt === undefined) {
      outages = [...outages.slice(0, -1), { ...last, endedAt: state.at_ms }];
    }
  }
  return {
    ...monitor,
    last: state,
    outages,
    stalledSince: state.pending_work.stalled
      ? (monitor.stalledSince ?? state.at_ms)
      : undefined,
    stalledAlerted: state.pending_work.stalled ? monitor.stalledAlerted : false,
  };
}

/**
 * Decide which notifications to fire now.
 *
 * Marks each outage so it never re-fires, and pairs the recovery notice with an
 * already-fired down alert — so a recovery notice cannot arrive for an outage
 * nobody was told about, and it lands even if alerts were toggled off
 * mid-outage. v0's `evaluateAlert`, carried.
 */
export function evaluateAlerts(
  monitor: MonitorState,
  config: AlertConfig,
  now: number
): { monitor: MonitorState; alerts: SeatAlert[] } {
  const alerts: SeatAlert[] = [];
  let next = monitor;

  const last = next.outages[next.outages.length - 1];
  if (last) {
    if (next.last?.connectivity !== "online" && last.endedAt === undefined) {
      const downForMs = now - last.startedAt;
      if (
        config.enabled &&
        last.alertedAt === undefined &&
        downForMs >= config.thresholdSeconds * 1000
      ) {
        next = {
          ...next,
          outages: [...next.outages.slice(0, -1), { ...last, alertedAt: now }],
        };
        alerts.push({ kind: "down", downForMs });
      }
    } else if (
      next.last?.connectivity === "online" &&
      last.endedAt !== undefined &&
      last.alertedAt !== undefined &&
      last.recoveredNoticeAt === undefined
    ) {
      next = {
        ...next,
        outages: [
          ...next.outages.slice(0, -1),
          { ...last, recoveredNoticeAt: now },
        ],
      };
      alerts.push({
        kind: "recovered",
        outageMs: last.endedAt - last.startedAt,
      });
    }
  }

  // A STALL IS NOT AN OUTAGE and has no threshold: the core's bounded event
  // queue filling means the screen is behind right now, and it is a build fact
  // about load rather than a self-healing blip.
  if (
    next.last?.pending_work.stalled &&
    !next.stalledAlerted &&
    config.enabled
  ) {
    next = { ...next, stalledAlerted: true };
    alerts.push({ kind: "stalled" });
  }

  return { monitor: next, alerts };
}

/** Compact human duration — `47s`, `3m 20s`, `2h 05m`, `1d 4h`. v0's, verbatim. */
export function formatDurationMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** The notification body for one alert. */
export function alertNotification(alert: SeatAlert): {
  title: string;
  body: string;
} {
  switch (alert.kind) {
    case "down":
      return {
        title: "Centraid cannot reach your gateway",
        body: `Offline for ${formatDurationMs(alert.downForMs)}. Everything you write is saved here and will sync when it is back.`,
      };
    case "recovered":
      return {
        title: "Centraid is back in sync",
        body: `Your gateway was unreachable for ${formatDurationMs(alert.outageMs)}.`,
      };
    case "crash-loop":
      // The supervisor's own sentence, quoted rather than summarised.
      return {
        title: "Centraid could not start its seat",
        body: alert.message,
      };
    case "stalled":
      return {
        title: "Centraid is catching up",
        body: "There is more to apply than this seat can keep up with, so some screens may be behind.",
      };
    case "unstalled":
      return {
        title: "Centraid has caught up",
        body: "Screens are current again.",
      };
  }
}
