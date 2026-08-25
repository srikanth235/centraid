/*
 * Pure detached-gateway decisions (#468, H2–H7); impure glue lives in
 * `detached-gateway.ts`. Crash-loop bookkeeping: `gateway-supervisor-core.ts`.
 */

/** Fixed port (H4) — pairing and the service unit need one. */
export const DEFAULT_GATEWAY_PORT = 17832;

export type ControlDecision =
  | "own"
  | "foreign"
  | "stale-reclaim"
  | "probe-failed-refuse";

/** Kernel lock + credentialed probe only; no pid or stale-file heuristics (H3). */
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

/** Keep the kinds distinct — each earns its own refusal. */
export type LockProbe =
  | { kind: "reported"; held: boolean; answering: boolean; holderPid?: number }
  | { kind: "custody-mismatch"; detail: string }
  | { kind: "holder-unresponsive" }
  | { kind: "cli-failed"; detail: string };

export interface LockStatusRun {
  stdout: string;
  stderr: string;
  status: number | null;
  /** The CLI was killed, not finished. */
  timedOut: boolean;
}

const CUSTODY_ERROR_PATTERN = /KeyStoreError|unwrap|master key/iu;

const NODE_DIAGNOSTIC_LINE = /^\(node:\d+\)/u;

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

export function classifyLockStatus(run: LockStatusRun): LockProbe {
  // Written as the CLI's last act — authoritative even if killed.
  const reported = parseLockStatusLine(run.stdout);
  if (reported) return reported;
  if (CUSTODY_ERROR_PATTERN.test(run.stderr)) {
    return {
      kind: "custody-mismatch",
      detail: stderrDetail(run.stderr, run.status, CUSTODY_ERROR_PATTERN),
    };
  }
  // After custody: a timeout only says the CLI never finished.
  if (run.timedOut) return { kind: "holder-unresponsive" };
  return {
    kind: "cli-failed",
    detail: stderrDetail(run.stderr, run.status),
  };
}

/** Fail-closed: an unreadable lock never permits a second writer. */
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

/** No stored wrapping key + existing envelopes = lost device credentials (E2). */
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

/** Detached children use `stdio: 'ignore'` (H2) — EADDRINUSE is invisible. */
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

export interface DetachedSpawnConfig {
  detached: true;
  stdio: "ignore";
  unref: true;
}

export function buildDetachedSpawnOptions(): DetachedSpawnConfig {
  return { detached: true, stdio: "ignore", unref: true };
}

/** Fresh installs only (H5); silent install is forbidden. */
export function shouldOfferServiceInstall(settings: {
  /** Absent = not asked yet. */
  offerGatewayService?: boolean;
  onboardingCompletedAt?: string;
}): boolean {
  if (typeof settings.offerGatewayService === "boolean") return false;
  return !settings.onboardingCompletedAt;
}

export const DEFAULT_OFFER_GATEWAY_SERVICE = false;
