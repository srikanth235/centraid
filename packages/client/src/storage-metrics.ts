/*
 * The five-metric storage derivation (issue #436 §6) — normative and computed
 * ONCE, here, so every surface (the Storage card, Settings → Storage, any
 * future report) reads the SAME numbers from one pure function instead of each
 * re-deriving a slightly different story. Framework-free by construction: no
 * React, no gateway client, no clock of its own — every time value is an input
 * so the derivation is exhaustively unit-testable and identical in a test, a
 * renderer, and a headless report.
 *
 * The five metrics (PROTOCOL.md § Profiles anchors the home bundle these read):
 *   1. Freshness      — how recently is the vault provably protected offsite?
 *   2. Recovery window — how far back can it be restored?
 *   3. Privacy        — a structural constant (sealed bytes, zero key custody).
 *   4. Cost           — bytes stored vs. quota, aggregated across store classes.
 *   5. Exit           — export is always available; restore egress cost, honest.
 *
 * The UI wave builds directly on the exported types/signature below — treat
 * them as the contract. Every timestamp is epoch milliseconds; the caller maps
 * gateway DTO strings/clocks into these shapes (see `getStorageStatus`,
 * `getStorageUsage`, the backup status DTOs, and the provider discovery
 * document). Threshold logic mirrors `backup-health.ts`'s "2× cadence" edge so
 * a green metric here can never disagree with a healthy backup component.
 */

// ---------------------------------------------------------------------------
// 1. Freshness
// ---------------------------------------------------------------------------

/** The four independent custody clocks the freshness metric reconciles. Each
 *  is epoch ms, or `null` when that protection event has never happened. */
export interface FreshnessClocks {
  /** Newest WAL segment the provider has acknowledged (RPO edge). */
  lastAckedWalSegmentAt: number | null;
  /** Watermark up to which the remote-primary outbox has fully drained. */
  outboxDrainedWatermarkAt: number | null;
  /** Newest full snapshot registered with the provider. */
  lastRegisteredSnapshotAt: number | null;
  /** Newest successful restore/verification pass. */
  lastSuccessfulVerificationAt: number | null;
}

export interface FreshnessInput {
  /** Declared protection cadence to anchor staleness against, in ms. The
   *  provider's `home` profile REQUIRES a `policy` capability precisely so this
   *  is a real declared value, not a client guess (PROTOCOL.md § Profiles). */
  declaredCadenceMs: number;
  clocks: FreshnessClocks;
}

export type FreshnessStatus = 'green' | 'yellow' | 'red' | 'unknown';

export interface FreshnessMetric {
  /** green ≤ 1× cadence, yellow past 1×, red past 2×; `unknown` when any clock
   *  is missing (an unproven edge can't be called fresh). */
  status: FreshnessStatus;
  /** T = min of the four clocks (worst clock wins); `null` when unknown. */
  tMs: number | null;
  /** `now - T`; `null` when unknown. */
  ageMs: number | null;
  declaredCadenceMs: number;
  /** Echoed back verbatim for the diagnostics disclosure. */
  clocks: FreshnessClocks;
}

function deriveFreshness(input: FreshnessInput, now: number): FreshnessMetric {
  const { clocks, declaredCadenceMs } = input;
  const values = [
    clocks.lastAckedWalSegmentAt,
    clocks.outboxDrainedWatermarkAt,
    clocks.lastRegisteredSnapshotAt,
    clocks.lastSuccessfulVerificationAt,
  ];
  // A missing clock is an unproven protection edge — the worst clock wins, and
  // "never happened" is the worst possible, so T (and status) is unknown.
  const anyMissing = values.some((v) => v === null);
  if (anyMissing) {
    return { status: 'unknown', tMs: null, ageMs: null, declaredCadenceMs, clocks };
  }
  const tMs = Math.min(...(values as number[]));
  const ageMs = now - tMs;
  let status: FreshnessStatus;
  if (ageMs <= declaredCadenceMs) status = 'green';
  else if (ageMs <= declaredCadenceMs * 2) status = 'yellow';
  else status = 'red';
  return { status, tMs, ageMs, declaredCadenceMs, clocks };
}

// ---------------------------------------------------------------------------
// 2. Recovery window
// ---------------------------------------------------------------------------

/** The provider's retention promise (discovery `backup.retention`,
 *  PROTOCOL.md). Structural subset of `@centraid/backup`'s `Retention` — kept
 *  local so this module stays dependency-free. */
export type RetentionInput =
  | { kind: 'ladder'; keepAllDays: number; dailyDays: number; weeklyDays: number }
  | { kind: 'none' };

export interface RecoveryWindowMetric {
  /** N days: the ladder's daily rung — the honest flat "you can restore any day
   *  within N days" promise. `null` when the provider promises no retention. */
  days: number | null;
  retention: RetentionInput;
}

function deriveRecoveryWindow(retention: RetentionInput): RecoveryWindowMetric {
  if (retention.kind === 'none') return { days: null, retention };
  return { days: retention.dailyDays, retention };
}

// ---------------------------------------------------------------------------
// 3. Privacy — a structural constant
// ---------------------------------------------------------------------------

export interface PrivacyMetric {
  /** Every remote object is a sealed CBSF envelope. */
  readonly sealedBytes: true;
  /** The provider holds no keys — custody never leaves the client. */
  readonly keyCustody: 'client-only';
  readonly description: string;
}

const PRIVACY_METRIC: PrivacyMetric = Object.freeze({
  sealedBytes: true,
  keyCustody: 'client-only',
  description:
    'Every byte is sealed client-side before it leaves the device; the provider stores ciphertext and holds no keys.',
});

// ---------------------------------------------------------------------------
// 4. Cost
// ---------------------------------------------------------------------------

/** Per-store usage figures (a subset of `StoreUsageReport`). */
export interface StoreUsageInput {
  bytesStored: number;
  /** `null` ⇒ that store is unmetered (no cap). */
  quotaBytes: number | null;
}

/** The provider-reported usage, keyed by store class. Absent keys contribute
 *  zero bytes. */
export type UsageInput = Partial<Record<'backup' | 'cas' | 'derived', StoreUsageInput>>;

export interface CostMetric {
  /** X — aggregate bytes stored across ALL store classes. */
  bytesStored: number;
  /** Y — the account quota; `null` when the provider doesn't meter. */
  quotaBytes: number | null;
  /** `bytesStored / quotaBytes`, or `null` when unmetered. */
  fractionUsed: number | null;
  /** `true` iff any store reported a quota. */
  metered: boolean;
}

function deriveCost(usage: UsageInput | null): CostMetric {
  if (!usage) {
    return { bytesStored: 0, quotaBytes: null, fractionUsed: null, metered: false };
  }
  let bytesStored = 0;
  let quotaBytes: number | null = null;
  for (const store of ['backup', 'cas', 'derived'] as const) {
    const report = usage[store];
    if (!report) continue;
    bytesStored += report.bytesStored;
    // The home bundle shares one account, so a per-store quota is that same
    // account cap echoed per store — take the largest reported value as Y
    // (equal in practice; robust if a provider reports only one store's cap).
    if (report.quotaBytes !== null) {
      quotaBytes =
        quotaBytes === null ? report.quotaBytes : Math.max(quotaBytes, report.quotaBytes);
    }
  }
  const metered = quotaBytes !== null;
  const fractionUsed = quotaBytes !== null && quotaBytes > 0 ? bytesStored / quotaBytes : null;
  return { bytesStored, quotaBytes, fractionUsed, metered };
}

// ---------------------------------------------------------------------------
// 5. Exit
// ---------------------------------------------------------------------------

export interface ExitMetric {
  /** Export is a structural guarantee — always available, no provider gate. */
  readonly exportAlwaysAvailable: true;
  /** Passed through honestly from discovery `backup.restoreCostClass`. */
  restoreCostClass: 'free-egress' | 'metered-egress';
}

function deriveExit(restoreCostClass: 'free-egress' | 'metered-egress'): ExitMetric {
  return { exportAlwaysAvailable: true, restoreCostClass };
}

// ---------------------------------------------------------------------------
// Combined derivation
// ---------------------------------------------------------------------------

export interface StorageMetricsInput {
  /** Reference clock (epoch ms) the freshness age is measured from. */
  now: number;
  freshness: FreshnessInput;
  retention: RetentionInput;
  /** Provider-reported per-store usage, or `null` before the first poll. */
  usage: UsageInput | null;
  restoreCostClass: 'free-egress' | 'metered-egress';
}

export interface StorageMetrics {
  freshness: FreshnessMetric;
  recoveryWindow: RecoveryWindowMetric;
  privacy: PrivacyMetric;
  cost: CostMetric;
  exit: ExitMetric;
}

/**
 * The one normative derivation of the five storage metrics (issue #436 §6).
 * Pure: given the same inputs it always returns the same metrics, with no
 * ambient clock or IO. See each metric's helper above for its rule.
 */
export function deriveStorageMetrics(input: StorageMetricsInput): StorageMetrics {
  return {
    freshness: deriveFreshness(input.freshness, input.now),
    recoveryWindow: deriveRecoveryWindow(input.retention),
    privacy: PRIVACY_METRIC,
    cost: deriveCost(input.usage),
    exit: deriveExit(input.restoreCostClass),
  };
}
