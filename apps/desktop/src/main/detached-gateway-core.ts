/*
 * Pure detached-gateway decisions (issue #468, H2–H7).
 *
 * The desktop gateway runs as a detached child process that outlives the UI
 * (H1). This module is Electron-free so the ownership / port / spawn-flag
 * rules unit-test without spawning anything. Impure glue (spawn, poll HTTP,
 * query gateway.db lock state) lives in `detached-gateway.ts` and
 * `local-gateway.ts`.
 *
 * H7 — crash-loop still uses {@link ./gateway-supervisor-core.ts}:
 * `recordFailure` / `loopBroken` / `backoffForAttempt` apply to detached
 * *spawn* failures the same way they applied to in-process `serve()`
 * failures. This file does not re-implement that bookkeeping; callers keep
 * using the supervisor core.
 *
 * H6 — lifecycle verbs (start / stop / status / service install) route
 * through the same bundled `centraid-gateway` CLI entry the OS service unit
 * (`dev.centraid.gateway`) uses, so the app and a terminal user share one
 * code path.
 */

/** Stable default listen port (H4). Replaces ephemeral port:0 for bookmarks / pairing / service. */
export const DEFAULT_GATEWAY_PORT = 17832;

/** Outcome of the adopt-don't-kill decision (H3). */
export type ControlDecision =
  | "own"
  | "foreign"
  | "stale-reclaim"
  | "probe-failed-refuse";

/**
 * Decide from the kernel-backed gateway.db lock and a credentialed daemon
 * probe. No pid, timestamp, or stale-file heuristic participates.
 */
export function decideControl(input: {
  lockHeld: boolean;
  credentialedProbeOk: boolean;
  publicProbeOk: boolean;
}): ControlDecision {
  if (!input.lockHeld) return "stale-reclaim";
  if (input.credentialedProbeOk) return "own";
  if (input.publicProbeOk) return "foreign";
  return "probe-failed-refuse";
}

/** Resolve the listen port: a positive configured port wins, else the stable default (H4). */
export function resolveListenPort(configured?: number): number {
  if (
    typeof configured === "number" &&
    Number.isInteger(configured) &&
    configured > 0 &&
    configured <= 65535
  ) {
    return configured;
  }
  return DEFAULT_GATEWAY_PORT;
}

/**
 * Spawn flags for a detached gateway child (H2). Returned as a plain config
 * object so tests can assert shape without calling `child_process.spawn`.
 * Wiring applies these to `spawn()` and then calls `child.unref()`.
 */
export interface DetachedSpawnConfig {
  detached: true;
  stdio: "ignore";
  /** Caller must `child.unref()` after spawn when this is true. */
  unref: true;
}

export function buildDetachedSpawnOptions(): DetachedSpawnConfig {
  return { detached: true, stdio: "ignore", unref: true };
}

/**
 * H5 — whether onboarding should **show** the OS service install step.
 * Opt-in; install itself defaults off ({@link DEFAULT_OFFER_GATEWAY_SERVICE}).
 * Silent install is forbidden.
 *
 * - `offerGatewayService` already set (true|false) → user decided → do not re-offer
 * - `onboardingCompletedAt` set → first-run over → do not re-offer here
 * - otherwise (fresh install) → show the step
 */
export function shouldOfferServiceInstall(settings: {
  /** Explicit opt-in (true) or declined (false). Absent = not asked yet. */
  offerGatewayService?: boolean;
  onboardingCompletedAt?: string;
}): boolean {
  if (typeof settings.offerGatewayService === "boolean") return false;
  return !settings.onboardingCompletedAt;
}

/** Default for whether the OS service is installed (H5) — off until opted in. */
export const DEFAULT_OFFER_GATEWAY_SERVICE = false;
