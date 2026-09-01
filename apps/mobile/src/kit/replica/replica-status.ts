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
  | "sync-paused"
  | "syncing";

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
  policyBlocked = false
): ReplicaReachability {
  if (policyBlocked) return "sync-paused";
  return pullLanded ? "current" : "gateway-asleep";
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
  return {
    label: `No longer shared with you — ${notice.label} was removed from this phone`,
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
  const next = existing.some((entry) => entry.vaultId === notice.vaultId)
    ? existing
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
          },
        ]
      : [];
  });
}
