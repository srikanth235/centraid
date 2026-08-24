/*
 * Pure detached-gateway decisions (#468, H2–H7).
 *
 * The desktop gateway runs as a detached child process that outlives the UI
 * (H1). This module is Electron-free so the ownership / port / spawn-flag
 * rules unit-test without spawning anything. Impure glue (spawn, poll HTTP,
 * query gateway.db lock state) lives in `detached-gateway.ts` and
 * `local-gateway.ts`.
 *
 * H7 — crash-loop still uses {@link ./gateway-supervisor-core.ts}:
 * `recordFailure` / `loopBroken` / `backoffForAttempt` apply to detached
 * *spawn* failures the same way they apply to in-process `serve()` failures.
 * Do not re-implement that bookkeeping here; callers use the supervisor core.
 *
 * H6 — lifecycle verbs (start / stop / status / service install) route
 * through the same bundled `centraid-gateway` CLI entry the OS service unit
 * (`dev.centraid.gateway`) uses, so the app and a terminal user share one
 * code path.
 */

/** Stable default listen port (H4) — bookmarks / pairing / service need a fixed port, not `port: 0`. */
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

/**
 * What `centraid-gateway lock-status` actually told us.
 *
 * Do not collapse everything unparseable into a fail-closed
 * `{held: true, answering: false}`: three unrelated situations then share one
 * message that is wrong for two of them:
 *
 *   - the CLI could not even open the key store (wrong/absent wrapping key) —
 *     the lock is very likely FREE and the real problem is device credential
 *     custody;
 *   - the CLI blocked on the holder's SQLite lock and we killed it at the
 *     spawn timeout — genuinely held, by a process that is not answering
 *     *anything*, and the CLI never got far enough to report the holder pid;
 *   - the CLI answered normally.
 *
 * Fail-closed stays the safety default for all of them (never start a second
 * writer on a maybe-locked db), but the refusal must say which one happened.
 * {@link classifyLockStatus} is the pure half.
 */
export type LockProbe =
  | { kind: "reported"; held: boolean; answering: boolean; holderPid?: number }
  | { kind: "custody-mismatch"; detail: string }
  | { kind: "holder-unresponsive" }
  | { kind: "cli-failed"; detail: string };

/** Raw `spawnSync` outcome, narrowed to what the classification needs. */
export interface LockStatusRun {
  stdout: string;
  stderr: string;
  status: number | null;
  /** True when the spawn hit its timeout (the CLI was killed, not finished). */
  timedOut: boolean;
}

/**
 * The key store throws `KeyStoreError` when an envelope will not unwrap under
 * the supplied master key, and the CLI prints the stack to stderr before
 * exiting 1. That string is the only signal the daemon boundary gives us.
 */
const CUSTODY_ERROR_PATTERN = /KeyStoreError|unwrap|master key/iu;

/**
 * Node writes its own diagnostics to the child's stderr — notably the
 * `(node:123) ExperimentalWarning: SQLite …` the gateway CLI always triggers —
 * so the first line is routinely not the failure. Skip those.
 */
const NODE_DIAGNOSTIC_LINE = /^\(node:\d+\)/u;

/** The most explanatory stderr line, preferring one that matches `prefer`. */
function stderrDetail(
  stderr: string,
  status: number | null,
  prefer?: RegExp
): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !NODE_DIAGNOSTIC_LINE.test(l));
  const preferred = prefer ? lines.find((l) => prefer.test(l)) : undefined;
  return preferred ?? lines[0] ?? `exit ${status ?? "unknown"}`;
}

/**
 * The CLI's `--json` line, or `undefined` when the last stdout line is not a
 * complete status object (killed mid-write, banner-only, empty). Translating a
 * parse failure into "no answer" is the recovery — the caller then reads the
 * process-level signals instead.
 */
function parseLockStatusLine(stdout: string): LockProbe | undefined {
  const line = stdout.trim().split("\n").pop() ?? "";
  if (!line.startsWith("{")) return undefined;
  let parsed: Partial<{
    ok: boolean;
    held: boolean;
    answering: boolean;
    holderPid: number;
  }>;
  try {
    parsed = JSON.parse(line) as typeof parsed;
  } catch {
    return undefined;
  }
  if (
    parsed.ok !== true ||
    typeof parsed.held !== "boolean" ||
    typeof parsed.answering !== "boolean"
  ) {
    return undefined;
  }
  return {
    kind: "reported",
    held: parsed.held,
    answering: parsed.answering,
    ...(typeof parsed.holderPid === "number"
      ? { holderPid: parsed.holderPid }
      : {}),
  };
}

/** Pure `lock-status` outcome classification — see {@link LockProbe}. */
export function classifyLockStatus(run: LockStatusRun): LockProbe {
  // A complete JSON line is authoritative even if the process was later
  // killed: the CLI writes it as its last act.
  const reported = parseLockStatusLine(run.stdout);
  if (reported) return reported;
  if (CUSTODY_ERROR_PATTERN.test(run.stderr)) {
    return {
      kind: "custody-mismatch",
      detail: stderrDetail(run.stderr, run.status, CUSTODY_ERROR_PATTERN),
    };
  }
  // Timeout is checked AFTER custody: a key-store failure is instant and
  // unambiguous, whereas the timeout only tells us the CLI never finished.
  if (run.timedOut) return { kind: "holder-unresponsive" };
  return {
    kind: "cli-failed",
    detail: stderrDetail(run.stderr, run.status),
  };
}

/**
 * Fail-closed lock view fed to {@link decideControl}. Anything we could not
 * read counts as held-and-not-answering, so an unreadable lock can never talk
 * us into spawning a second writer. The *diagnosis* is carried separately by
 * the {@link LockProbe} and surfaces in {@link describeLockRefusal}.
 */
export function lockViewFor(probe: LockProbe): {
  held: boolean;
  answering: boolean;
  holderPid?: number;
} {
  if (probe.kind !== "reported") return { held: true, answering: false };
  return {
    held: probe.held,
    answering: probe.answering,
    ...(probe.holderPid === undefined ? {} : { holderPid: probe.holderPid }),
  };
}

/**
 * The refusal message for `probe-failed-refuse`, keyed by what actually went
 * wrong. `holderPid` is the OS-level fallback (fcntl/lsof on gateway.db) the
 * caller resolves when the CLI could not name the holder itself — which is
 * exactly the unresponsive-holder case, since the CLI blocks on the same lock.
 */
export function describeLockRefusal(input: {
  probe: LockProbe;
  dataDir: string;
  holderPid?: number;
}): string {
  const pid = input.holderPid;
  const pidSuffix = pid === undefined ? "" : ` (OS holder pid ${pid})`;
  switch (input.probe.kind) {
    case "custody-mismatch":
      return (
        `this device can no longer unlock the gateway key store in ${input.dataDir} — ` +
        "its device credentials are missing or were replaced, so the existing keys/ " +
        "envelopes will not open. gateway.db itself is not locked. Restore this Mac's " +
        "device credential file, re-pair this desktop, or erase and re-found the gateway " +
        `(${input.probe.detail})`
      );
    case "holder-unresponsive":
      return (
        `a process is holding gateway.db in ${input.dataDir} and is not responding${pidSuffix} — ` +
        "reading the lock timed out against it too. Refusing to start a second writer; " +
        "quit or kill the holder, then try again."
      );
    case "cli-failed":
      return (
        `could not read the gateway.db lock state in ${input.dataDir}${pidSuffix} ` +
        `(${input.probe.detail}) — refusing to start a second writer while it is unknown.`
      );
    case "reported":
      return (
        "gateway.db is locked but the daemon is not answering — refusing to start " +
        `a second writer${pidSuffix}`
      );
  }
}

/**
 * E2 — the gateway data directory outlived this device's credentials.
 *
 * `getOrCreateGatewayWrappingKey` mints a fresh key whenever the device
 * secrets file has none, which is silently correct for a brand-new gateway and
 * silently catastrophic for an existing one: the new key cannot open the
 * envelopes already sitting in `<dataDir>/keys`. Detect that pairing here so
 * the failure reports the credential problem instead of decaying into a bogus
 * lock refusal several steps later.
 */
export function deviceCustodyGap(input: {
  hasStoredWrappingKey: boolean;
  gatewayKeysPresent: boolean;
}): boolean {
  return !input.hasStoredWrappingKey && input.gatewayKeysPresent;
}

export function describeDeviceCustodyGap(dataDir: string): string {
  return (
    `the gateway in ${dataDir} already has key-store envelopes, but this Mac holds no ` +
    "device credential for it — the credential file was removed or replaced. Minting a " +
    "new key here would leave those envelopes permanently unopenable, so startup stops. " +
    "Restore the device credential file from backup, re-pair this desktop, or erase the " +
    "gateway data directory and re-found it."
  );
}

/**
 * A leftover daemon bound to the configured port but serving a DIFFERENT data
 * dir leaves our fresh spawn to die on EADDRINUSE — invisibly, because a
 * detached child is spawned with `stdio: 'ignore'` (H2). A pre-spawn probe is
 * the only cheap way to turn that into a sentence.
 */
export function describePortConflict(input: {
  host: string;
  port: number;
  dataDir: string;
  pid?: number;
}): string {
  return (
    `another process${input.pid === undefined ? "" : ` (pid ${input.pid})`} is already ` +
    `listening on ${input.host}:${input.port} and it is not this desktop's gateway for ` +
    `${input.dataDir}. Stop it (or configure a different port) before starting a gateway here.`
  );
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
