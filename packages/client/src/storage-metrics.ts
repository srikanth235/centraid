/*
 * The five storage metrics (#436), derived ONCE here so every surface reads the
 * SAME numbers. Keep it framework-free, every time value an input; epoch ms
 * throughout. Thresholds mirror `backup-health.ts`'s 2× cadence edge, so a
 * green metric here cannot disagree with a healthy backup component.
 */

/** Epoch ms each, or `null` when that protection event has never happened. */
export interface FreshnessClocks {
  lastAckedWalSegmentAt: number | null;
  outboxDrainedWatermarkAt: number | null;
  lastRegisteredSnapshotAt: number | null;
  lastSuccessfulVerificationAt: number | null;
}

export interface FreshnessInput {
  declaredCadenceMs: number;
  clocks: FreshnessClocks;
}

export type FreshnessStatus = "green" | "yellow" | "red" | "unknown";

export interface FreshnessMetric {
  /** green ≤ 1× cadence, yellow past 1×, red past 2×. */
  status: FreshnessStatus;
  tMs: number | null;
  ageMs: number | null;
  declaredCadenceMs: number;
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
  // A missing clock is an unproven edge, and "never" is the worst clock.
  const anyMissing = values.some((v) => v === null);
  if (anyMissing) {
    return {
      status: "unknown",
      tMs: null,
      ageMs: null,
      declaredCadenceMs,
      clocks,
    };
  }
  const tMs = Math.min(...(values as number[]));
  const ageMs = now - tMs;
  let status: FreshnessStatus;
  if (ageMs <= declaredCadenceMs) status = "green";
  else if (ageMs <= declaredCadenceMs * 2) status = "yellow";
  else status = "red";
  return { status, tMs, ageMs, declaredCadenceMs, clocks };
}

export type RetentionInput =
  | {
      kind: "ladder";
      keepAllDays: number;
      dailyDays: number;
      weeklyDays: number;
    }
  | { kind: "none" };

export interface RecoveryWindowMetric {
  days: number | null;
  retention: RetentionInput;
}

function deriveRecoveryWindow(retention: RetentionInput): RecoveryWindowMetric {
  if (retention.kind === "none") return { days: null, retention };
  return { days: retention.dailyDays, retention };
}

export interface PrivacyMetric {
  readonly sealedBytes: true;
  readonly keyCustody: "client-only";
  readonly description: string;
}

const PRIVACY_METRIC: PrivacyMetric = Object.freeze({
  sealedBytes: true,
  keyCustody: "client-only",
  description:
    "Every byte is sealed client-side before it leaves the device; the provider stores ciphertext and holds no keys.",
});

export interface StoreUsageInput {
  bytesStored: number;
  quotaBytes: number | null;
}

export type UsageInput = Partial<
  Record<"backup" | "cas" | "derived", StoreUsageInput>
>;

export interface CostMetric {
  bytesStored: number;
  quotaBytes: number | null;
  fractionUsed: number | null;
  metered: boolean;
}

function deriveCost(usage: UsageInput | null): CostMetric {
  if (!usage) {
    return {
      bytesStored: 0,
      quotaBytes: null,
      fractionUsed: null,
      metered: false,
    };
  }
  let bytesStored = 0;
  let quotaBytes: number | null = null;
  for (const store of ["backup", "cas", "derived"] as const) {
    const report = usage[store];
    if (!report) continue;
    bytesStored += report.bytesStored;
    // One account, so a per-store quota is that cap echoed: take the largest.
    if (report.quotaBytes !== null) {
      quotaBytes =
        quotaBytes === null
          ? report.quotaBytes
          : Math.max(quotaBytes, report.quotaBytes);
    }
  }
  const metered = quotaBytes !== null;
  const fractionUsed =
    quotaBytes !== null && quotaBytes > 0 ? bytesStored / quotaBytes : null;
  return { bytesStored, quotaBytes, fractionUsed, metered };
}

export interface ExitMetric {
  readonly exportAlwaysAvailable: true;
  restoreCostClass: "free-egress" | "metered-egress";
}

function deriveExit(
  restoreCostClass: "free-egress" | "metered-egress"
): ExitMetric {
  return { exportAlwaysAvailable: true, restoreCostClass };
}

export interface StorageMetricsInput {
  now: number;
  freshness: FreshnessInput;
  retention: RetentionInput;
  usage: UsageInput | null;
  restoreCostClass: "free-egress" | "metered-egress";
}

export interface StorageMetrics {
  freshness: FreshnessMetric;
  recoveryWindow: RecoveryWindowMetric;
  privacy: PrivacyMetric;
  cost: CostMetric;
  exit: ExitMetric;
}

export function deriveStorageMetrics(
  input: StorageMetricsInput
): StorageMetrics {
  return {
    freshness: deriveFreshness(input.freshness, input.now),
    recoveryWindow: deriveRecoveryWindow(input.retention),
    privacy: PRIVACY_METRIC,
    cost: deriveCost(input.usage),
    exit: deriveExit(input.restoreCostClass),
  };
}
