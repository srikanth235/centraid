export type ReplicaRebootstrapVerdict =
  | "epoch-mismatch"
  | "retention"
  | "cursor-ahead"
  | "initial"
  | "epoch-changed"
  | "snapshot-retention"
  | "shape-changed"
  | "checkpoint-incompatible"
  | "invalid-cursor";

export interface ReplicaRetentionFacts {
  days: number;
  maxEntries: number;
}

export interface ReplicaRebootstrapNotice {
  verdict: ReplicaRebootstrapVerdict;
  headline: string;
  detail: string;
  fullResync: boolean;
}

const NOTICE_VERDICTS: readonly ReplicaRebootstrapVerdict[] = [
  "epoch-mismatch",
  "retention",
  "cursor-ahead",
  "initial",
  "epoch-changed",
  "snapshot-retention",
  "shape-changed",
  "checkpoint-incompatible",
  "invalid-cursor",
];

export function isRebootstrapVerdict(
  value: unknown
): value is ReplicaRebootstrapVerdict {
  return (
    typeof value === "string" &&
    (NOTICE_VERDICTS as readonly string[]).includes(value)
  );
}

const FULL =
  "This device is downloading its whole library again — your unsent changes stay queued.";

export function rebootstrapNoticeFor(
  verdict: ReplicaRebootstrapVerdict,
  retention?: ReplicaRetentionFacts
): ReplicaRebootstrapNotice {
  const days = retention?.days;
  switch (verdict) {
    case "retention":
      return {
        verdict,
        headline: FULL,
        detail: days
          ? `It was offline longer than the ${days} days of changes this gateway keeps, so a full download is the only way back.`
          : "It was offline longer than the run of changes this gateway keeps, so a full download is the only way back.",
        fullResync: true,
      };
    case "snapshot-retention":
      return {
        verdict,
        headline: FULL,
        detail:
          "Its first sync outlasted the changes the gateway could hold meanwhile, so the download restarts from a fresh point.",
        fullResync: true,
      };
    case "epoch-mismatch":
    case "epoch-changed":
      return {
        verdict,
        headline: FULL,
        detail:
          "The gateway rebuilt the vault's change history — after a restore or a repair — so this device's place in it is gone.",
        fullResync: true,
      };
    case "cursor-ahead":
      return {
        verdict,
        headline: FULL,
        detail:
          "This device was ahead of the gateway's own history, which happens after the gateway is restored from an older copy.",
        fullResync: true,
      };
    case "checkpoint-incompatible":
      return {
        verdict,
        headline: FULL,
        detail:
          "The saved point this device would resume from cannot be read by the gateway's version, so the library is fetched fresh.",
        fullResync: true,
      };
    case "invalid-cursor":
      return {
        verdict,
        headline: FULL,
        detail:
          "The gateway could not make sense of where this device had got to, so it is starting over rather than guessing.",
        fullResync: true,
      };
    case "shape-changed":
      return {
        verdict,
        headline: "This device is refreshing what it keeps offline.",
        detail:
          "Your view of this vault changed, so the offline copy is being rebuilt to match it.",
        fullResync: false,
      };
    case "initial":
      return {
        verdict,
        headline: "This device is fetching its first copy of the library.",
        detail:
          "Nothing is wrong — there is no offline copy here yet, so the gateway is sending one.",
        fullResync: false,
      };
  }
}

interface RebootstrapDetailShape {
  reason?: unknown;
  retention?: { days?: unknown; maxEntries?: unknown };
}

export function rebootstrapNoticeFrom(
  detail: unknown
): ReplicaRebootstrapNotice | undefined {
  if (!detail || typeof detail !== "object") return undefined;
  const shape = detail as RebootstrapDetailShape;
  if (!isRebootstrapVerdict(shape.reason)) return undefined;
  const days = shape.retention?.days;
  const maxEntries = shape.retention?.maxEntries;
  const retention =
    typeof days === "number" && typeof maxEntries === "number"
      ? { days, maxEntries }
      : undefined;
  return rebootstrapNoticeFor(shape.reason, retention);
}
