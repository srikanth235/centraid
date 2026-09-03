import type { ReplicaCoverage } from "@centraid/client/replica/native";

import type { AsyncStorageLike } from "../../lib/replica/native-change-feed";

export type ReplicaReachability =
  | "current"
  | "device-offline"
  | "gateway-asleep"
  | "sync-paused"
  | "syncing";

export function settledReachability(
  pullLanded: boolean,
  policyBlocked = false
): ReplicaReachability {
  if (policyBlocked) return "sync-paused";
  return pullLanded ? "current" : "gateway-asleep";
}

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

export function replicaCoverageRow(input: {
  coverage?: ReplicaCoverage;
  bootstrapping: boolean;
}): ReplicaStatusRow {
  if (input.bootstrapping || input.coverage !== "partial") return SILENT;
  return {
    actionable: false,
    label: "Recent items ready; older history syncing",
  };
}

export interface ReplicaRevokedNotice {
  vaultId: string;
  label: string;
  at: string;
}

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
    return [];
  }
}

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
    // Intentionally empty.
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
