// A row must be actionable or awaited; `device-offline` stays silent because
// the replica is local — a notice there reads as a fault.
//
// This module owns the replica surface's WORDS, and the one small durable
// record that stands behind a row nothing else remembers (a revoked scope's
// notice). Storage is injected, never imported, so the vocabulary stays
// renderer-free and unit-testable.

import type { ReplicaCoverage } from "@centraid/client/replica/native";

import type { AsyncStorageLike } from "../../lib/replica/native-change-feed";

export type ReplicaReachability =
  | "current"
  | "device-offline"
  | "gateway-asleep"
  | "gateway-refusing"
  | "sync-paused"
  | "syncing";

/**
 * A REFUSAL IS NOT AN ABSENCE (#1014, P11).
 *
 * Every non-landed pull read as `gateway-asleep`, so a gateway that answered —
 * and said no — put "Gateway asleep · Wake help" on the member's screen. The
 * gateway is awake; waking it is not the remedy and cannot become one, so the
 * member retries forever against a machine that is refusing them by design.
 *
 * The seat client raises `auth_required` for exactly this (`GatewayClientError`
 * in `@centraid/client`), and the sync-error sink keeps the last one — so the
 * fact is already on the phone; only the reading of it was wrong.
 */
export function isGatewayRefusal(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; status?: unknown };
  if (candidate.code === "auth_required") return true;
  return candidate.status === 401 || candidate.status === 403;
}

/**
 * `syncing` is optimistic, so every pass must settle or it pins forever.
 *
 * `policyBlocked` is the member's own transfer rules refusing the radio
 * (Wi-Fi only, no metered, charging only). It is NOT a failed pull: nothing
 * was asked of the gateway, so reading it as `current` claims a freshness the
 * phone never obtained, and reading it as `gateway-asleep` blames a gateway
 * that was never dialled.
 */
export function settledReachability(
  pullLanded: boolean,
  policyBlocked = false,
  /**
   * The pass that just settled, if it kept why it failed (#1014, P11). Taken
   * whole rather than as the error alone so the caller stays one line: the
   * only field read is `lastSyncError`.
   */
  pass?: { readonly lastSyncError?: unknown } | undefined
): ReplicaReachability {
  if (policyBlocked) return "sync-paused";
  if (pullLanded) return "current";
  // A refusal outranks "asleep": the gateway answered.
  return isGatewayRefusal(pass?.lastSyncError)
    ? "gateway-refusing"
    : "gateway-asleep";
}

/**
 * What a pass may claim BEFORE asking the gateway anything: a resolved URL is
 * not an answer, so optimism needs a good previous one
 * (docs/traps/unreachable-vault.md).
 */
export function attemptedReachability(
  deviceOnline: boolean,
  hasGatewayBase: boolean,
  wasOnline: boolean
): ReplicaReachability {
  if (!deviceOnline) return "device-offline";
  if (!hasGatewayBase) return "gateway-asleep";
  return wasOnline ? "syncing" : "gateway-asleep";
}

export interface ReplicaStatusRow {
  /** Absent when the state earns no row. */
  label?: string;
  action?: string;
  actionable: boolean;
}

const SILENT: ReplicaStatusRow = { actionable: false };

export function replicaStatusRow(
  reachability: ReplicaReachability
): ReplicaStatusRow {
  switch (reachability) {
    case "gateway-asleep":
      return { action: "Wake help", actionable: true, label: "Gateway asleep" };
    case "gateway-refusing":
      // Actionable, and the action is NOT "wake": the gateway is awake and
      // saying no. Access is what changed, so access is where the member goes.
      return {
        action: "Check access",
        actionable: true,
        label: "Gateway refused this device",
      };
    case "sync-paused":
      // Neutral, not red: the member chose these rules, so a danger dot beside
      // them reads as a fault the phone hit rather than a setting they set.
      // No action either — pulling again re-hits the same rule; the switch that
      // would help lives on the storage screen's transfer rules.
      return { actionable: false, label: "Sync paused by transfer rules" };
    case "syncing":
      return {
        action: "Sync now",
        actionable: false,
        label: "Syncing recent changes…",
      };
    case "current":
    case "device-offline":
      return SILENT;
  }
}

/**
 * The partial-library row, for the case no in-process bootstrap is running.
 *
 * An app killed mid-backfill and relaunched offline has a truncated library and
 * no `bootstrapProgress` to explain it, because the walk that would have
 * reported progress died with the old process. Coverage is the durable fact
 * (docs/mobile-offline.md: a partial preview is readable and searchable, but it
 * is labeled partial), so the label comes from coverage when nothing is
 * actively reporting pages.
 */
export function replicaCoverageRow(input: {
  coverage?: ReplicaCoverage;
  /** A live bootstrap already speaks, with an exact page count. */
  bootstrapping: boolean;
}): ReplicaStatusRow {
  if (input.bootstrapping || input.coverage !== "partial") return SILENT;
  return {
    actionable: false,
    label: "Recent items ready; older history syncing",
  };
}

/** A scope that was revoked while this phone held it, kept until dismissed. */
export interface ReplicaRevokedNotice {
  vaultId: string;
  label: string;
  /** ISO instant the revoked frame purged this scope. */
  at: string;
  /**
   * Unsent changes the purge took from the member (#1014, P24; R-1014-12).
   *
   * Absent means "not counted" — a notice written by a build before this, or
   * one whose purge never reported. Zero means counted and there were none,
   * which is a different and better thing to be able to say.
   */
  unsent?: number;
  /** False when the export could not be written and the count is all there is. */
  unsentSaved?: boolean;
}

/**
 * Purging a revoked scope is silent by construction — the rows, the cursor and
 * the mount all go, so nothing on the phone can afterwards say why a vault
 * vanished. This notice is the one trace left behind, and it outlives the
 * process because the relaunch after a purge is exactly when it is asked for.
 */
export function revokedNoticeRow(notice: ReplicaRevokedNotice): {
  label: string;
  action: string;
} {
  const removed = `No longer shared with you — ${notice.label} was removed from this phone`;
  // NEVER SILENT ABOUT WHAT WENT WITH IT (#1014, P24). Revocation is about
  // access, not about the member's past writes; a purge that took unsent edits
  // and reported only "removed" was the loss this sentence exists to end.
  if (notice.unsent === undefined || notice.unsent <= 0)
    return { label: removed, action: "Dismiss" };
  const changes = `${notice.unsent} unsent change${notice.unsent === 1 ? "" : "s"}`;
  return {
    label:
      notice.unsentSaved === false
        ? `${removed}. ${changes} could not be saved.`
        : `${removed}. ${changes} were saved to this phone.`,
    action: "Dismiss",
  };
}

export function revokedNoticesKey(gatewayId: string): string {
  return `centraid:replica-revoked:${encodeURIComponent(gatewayId)}`;
}

export async function loadRevokedNotices(
  storage: AsyncStorageLike,
  gatewayId: string
): Promise<ReplicaRevokedNotice[]> {
  try {
    const raw = await storage.getItem(revokedNoticesKey(gatewayId));
    return raw ? parseRevokedNotices(JSON.parse(raw) as unknown) : [];
  } catch {
    // A corrupt notice list costs a member one explanation, never their data.
    return [];
  }
}

/** Idempotent per vault: a re-delivered revoked frame keeps the first instant. */
export async function recordRevokedNotice(
  storage: AsyncStorageLike,
  gatewayId: string,
  notice: ReplicaRevokedNotice
): Promise<ReplicaRevokedNotice[]> {
  const existing = await loadRevokedNotices(storage, gatewayId);
  const held = existing.find((entry) => entry.vaultId === notice.vaultId);
  // Idempotent on the INSTANT, not on the whole row: the count arrives after
  // the notice (the label is written before the purge, the number only exists
  // once it has run), so a later record may fill it in (#1014, P24).
  const next = held
    ? existing.map((entry) =>
        entry.vaultId === notice.vaultId
          ? {
              ...entry,
              ...(notice.unsent === undefined ? {} : { unsent: notice.unsent }),
              ...(notice.unsentSaved === undefined
                ? {}
                : { unsentSaved: notice.unsentSaved }),
            }
          : entry
      )
    : [...existing, notice];
  await writeRevokedNotices(storage, gatewayId, next);
  return next;
}

export async function dismissRevokedNotice(
  storage: AsyncStorageLike,
  gatewayId: string,
  vaultId: string
): Promise<ReplicaRevokedNotice[]> {
  const next = (await loadRevokedNotices(storage, gatewayId)).filter(
    (entry) => entry.vaultId !== vaultId
  );
  await writeRevokedNotices(storage, gatewayId, next);
  return next;
}

async function writeRevokedNotices(
  storage: AsyncStorageLike,
  gatewayId: string,
  notices: readonly ReplicaRevokedNotice[]
): Promise<void> {
  try {
    if (notices.length === 0)
      await storage.removeItem(revokedNoticesKey(gatewayId));
    else
      await storage.setItem(
        revokedNoticesKey(gatewayId),
        JSON.stringify(notices)
      );
  } catch {
    // The in-memory notice still renders for this process.
  }
}

function parseRevokedNotices(value: unknown): ReplicaRevokedNotice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as Record<string, unknown>;
    return typeof candidate["vaultId"] === "string" &&
      typeof candidate["label"] === "string" &&
      typeof candidate["at"] === "string"
      ? [
          {
            vaultId: candidate["vaultId"],
            label: candidate["label"],
            at: candidate["at"],
            ...(typeof candidate["unsent"] === "number"
              ? { unsent: candidate["unsent"] }
              : {}),
            ...(typeof candidate["unsentSaved"] === "boolean"
              ? { unsentSaved: candidate["unsentSaved"] }
              : {}),
          },
        ]
      : [];
  });
}
