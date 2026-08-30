import { DAY_MS } from "@centraid/blueprints/apps/_shared/format-kit";

import type { ShellRoute } from "../../app-shell-context.js";
// The shell's standing status sentence (#707, invariant 5). "unknown" never
// resolves to "Ready": that is what the line shows when all is fine but idle,
// and a dial attempt runs ~30s with retries.
import { OFFLINE_COMMIT_REASON } from "./commitAvailability.js";

export type SignalTone = "quiet" | "attention" | "urgent";
export type SignalSeat = "custodian" | "origin" | "viewer";

export interface AmbientSignalInput {
  seat: SignalSeat;
  gatewayStatus: "unknown" | "up" | "down" | undefined;
  now: number;
  gatewayDownSince?: number;
  lastBackupAt?: number;
  lastKnownAt?: number;
  deviceCount?: number;
  pendingUploads?: number;
  onlyHereCount?: number;
}

export interface AmbientSignal {
  tone: SignalTone;
  copy: string;
  action?: { label: string; route: ShellRoute };
}

function ageLabel(at: number | undefined, now: number): string | undefined {
  if (at === undefined) return undefined;
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 60) return `${Math.max(1, minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/** Seat-first fold over pre-read facts; missing facts shorten, never make
 *  more certain. */
export function ambientSignalFor(input: AmbientSignalInput): AmbientSignal {
  const { gatewayStatus, now, seat } = input;
  if (gatewayStatus === "unknown" || gatewayStatus === undefined)
    return { copy: "Checking your vault…", tone: "quiet" };
  if (gatewayStatus === "down") {
    if (seat === "origin") {
      const onlyHere = input.onlyHereCount ?? 0;
      return {
        action: { label: "What to do", route: { kind: "approvals" } },
        copy:
          onlyHere > 0
            ? `Can’t reach your vault · ${onlyHere} ${onlyHere === 1 ? "item exists" : "items exist"} only here`
            : "Can’t reach your vault",
        tone: "urgent",
      };
    }
    if (seat === "viewer") {
      const known = ageLabel(input.lastKnownAt, now);
      return {
        action: { label: "Try again", route: { kind: "gateway" } },
        copy: `Can’t reach your vault${known ? ` — showing what was known ${known}` : ""}`,
        tone: "urgent",
      };
    }
    const since = ageLabel(input.gatewayDownSince, now);
    return {
      action: { label: "Open System", route: { kind: "gateway" } },
      copy: `Vault host unavailable${since ? ` since ${since.replace(" ago", "")}` : ""}`,
      tone: "urgent",
    };
  }

  const backupAge =
    input.lastBackupAt === undefined ? undefined : now - input.lastBackupAt;
  if (backupAge !== undefined && backupAge >= 2 * DAY_MS) {
    const days = Math.floor(backupAge / DAY_MS);
    const copy = `Backup overdue by ${days} ${days === 1 ? "day" : "days"}`;
    return seat === "viewer"
      ? { copy, tone: "attention" }
      : {
          action: {
            label: "Back up now",
            route: {
              kind: "gateway",
              focus: "backups",
              cause: "backup-alert",
            },
          },
          copy,
          tone: "attention",
        };
  }

  if (seat === "origin") {
    const pending = input.onlyHereCount ?? input.pendingUploads ?? 0;
    return pending > 0
      ? {
          action: { label: "Upload on Wi-Fi", route: { kind: "storage" } },
          copy: `${pending} ${pending === 1 ? "item" : "items"} only on this phone`,
          tone: "attention",
        }
      : {
          copy: `Everything’s uploaded${input.lastBackupAt ? ` · vault backed up ${ageLabel(input.lastBackupAt, now)}` : ""}`,
          tone: "quiet",
        };
  }
  if (seat === "viewer") {
    return {
      copy: `Up to date${input.lastKnownAt ? ` as of ${ageLabel(input.lastKnownAt, now)}` : ""}`,
      tone: "quiet",
    };
  }
  const backup = ageLabel(input.lastBackupAt, now);
  const copies = input.deviceCount;
  return {
    copy: [
      "All safe",
      backup ? `backed up ${backup}` : undefined,
      copies === undefined
        ? undefined
        : `${copies} ${copies === 1 ? "device" : "devices"} in sync`,
    ]
      .filter(Boolean)
      .join(" · "),
    tone: "quiet",
  };
}

/**
 * Reachable sentence + freshness stamp; `StatusLine` renders the stamp since
 * the age changes every second and the shell root skips heartbeat re-renders
 * (#659).
 */
export const SYNCED = "Synced";

export function syncedStamp(
  lastCheckAt: number | undefined,
  now: number
): string | undefined {
  if (lastCheckAt === undefined) return undefined;
  const seconds = Math.max(0, Math.round((now - lastCheckAt) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

export interface AmbientStatusInput {
  /** The heartbeat monitor's verdict; `undefined` before the first read. */
  gatewayStatus: "unknown" | "up" | "down" | undefined;
  /** Approvals waiting on a human decision. */
  blockingCount: number;
  hasUnreadNotices: boolean;
}

/** The resting line: work waiting on the member outranks reachability — it is
 *  the one of the three they can act on. */
export function ambientStatusFor(input: AmbientStatusInput): string {
  const { blockingCount, gatewayStatus, hasUnreadNotices } = input;
  if (blockingCount > 0)
    return `${blockingCount} ${blockingCount === 1 ? "decision" : "decisions"} waiting on you`;
  if (hasUnreadNotices) return "New notices to read";
  if (gatewayStatus === "up") return SYNCED;
  // Same sentence the offline banner and a refused commit carry.
  if (gatewayStatus === "down") return OFFLINE_COMMIT_REASON;
  return "Checking…";
}
