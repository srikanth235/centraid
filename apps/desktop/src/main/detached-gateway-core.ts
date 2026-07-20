/*
 * Pure detached-gateway decisions (issue #468, H2–H7).
 *
 * The desktop gateway runs as a detached child process that outlives the UI
 * (H1). This module is Electron-free so the ownership / port / spawn-flag
 * rules unit-test without spawning anything. Impure glue (spawn, poll HTTP,
 * read/write stamp files) lives in `detached-gateway.ts` and
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

/** Who stamped the running gateway into `gateway.ownership.json`. */
export type GatewayOwnerKind = 'desktop' | 'cli' | 'service';

/** On-disk ownership stamp — "who started this" (H3). */
export interface OwnershipStamp {
  owner: GatewayOwnerKind;
  ownerId: string;
  pid: number;
  startedAt: string;
}

/** Filename under the gateway data dir for the ownership stamp. */
export const OWNERSHIP_FILE = 'gateway.ownership.json';

/** Filename under the gateway data dir for the live status snapshot. */
export const STATUS_FILE = 'gateway.status.json';

/** On-disk status written after a successful bind / probe (H4). */
export interface GatewayStatusFile {
  url: string;
  host: string;
  port: number;
  pid: number;
  tokenFile?: string;
  renewedAt: string;
}

/** Outcome of the adopt-don't-kill decision (H3). */
export type ControlDecision = 'own' | 'foreign' | 'stale-reclaim' | 'probe-failed-refuse';

/**
 * Decide whether we may control (stop/restart) a gateway at a data dir.
 *
 * Rules (H3):
 *   - Own ownerId → `own` (stop/restart allowed; wiring still checks pid liveness).
 *   - Different owner + probeOk → `foreign` (never kill).
 *   - Different owner + !probeOk → `probe-failed-refuse` (do NOT reclaim when
 *     the status probe itself failed — the foreign process may still be live).
 *   - Missing stamp + probeOk → `foreign` (unknown live process).
 *   - Missing stamp + !probeOk → `stale-reclaim` (nothing live; safe to spawn).
 */
export function canControl(
  stamp: OwnershipStamp | null | undefined,
  ourOwnerId: string,
  options: { probeOk: boolean; ourPid?: number },
): ControlDecision {
  if (stamp && stamp.ownerId === ourOwnerId) {
    return 'own';
  }
  if (options.probeOk) {
    return 'foreign';
  }
  if (stamp && stamp.ownerId !== ourOwnerId) {
    return 'probe-failed-refuse';
  }
  return 'stale-reclaim';
}

/**
 * Whether `pid` is still running. `checkFn` is injectable so unit tests
 * never touch the real process table (e.g. `(p) => alive.has(p)`).
 */
export function isProcessAlive(pid: number, checkFn: (pid: number) => boolean): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  return checkFn(pid);
}

/** Resolve the listen port: a positive configured port wins, else the stable default (H4). */
export function resolveListenPort(configured?: number): number {
  if (
    typeof configured === 'number' &&
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
  stdio: 'ignore';
  /** Caller must `child.unref()` after spawn when this is true. */
  unref: true;
}

export function buildDetachedSpawnOptions(): DetachedSpawnConfig {
  return { detached: true, stdio: 'ignore', unref: true };
}

/** Build an ownership stamp for a just-spawned (or adopted) process. */
export function buildOwnershipStamp(input: {
  owner: GatewayOwnerKind;
  ownerId: string;
  pid: number;
  startedAt?: string;
}): OwnershipStamp {
  return {
    owner: input.owner,
    ownerId: input.ownerId,
    pid: input.pid,
    startedAt: input.startedAt ?? new Date().toISOString(),
  };
}

/** Build a status payload after the listen address is known. */
export function buildStatusFile(input: {
  host: string;
  port: number;
  pid: number;
  tokenFile?: string;
  renewedAt?: string;
}): GatewayStatusFile {
  return {
    url: `http://${input.host}:${input.port}`,
    host: input.host,
    port: input.port,
    pid: input.pid,
    ...(input.tokenFile !== undefined ? { tokenFile: input.tokenFile } : {}),
    renewedAt: input.renewedAt ?? new Date().toISOString(),
  };
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
  if (typeof settings.offerGatewayService === 'boolean') return false;
  return !settings.onboardingCompletedAt;
}

/** Default for whether the OS service is installed (H5) — off until opted in. */
export const DEFAULT_OFFER_GATEWAY_SERVICE = false;
