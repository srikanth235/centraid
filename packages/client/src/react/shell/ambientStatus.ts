import type { ShellRoute } from "../../app-shell-context.js";
// The standing sentence on the shell's one status line (issue #707,
// invariant 5) — extracted from App so the rule can be read, and tested,
// without mounting the whole shell.
//
// The reachability half of it used to be a two-way ternary: "up" said "Synced"
// and EVERYTHING ELSE said "Ready". That made the line lie in the one state
// where the shell knows least. "unknown" is not a short blip on the web host —
// an Iroh dial times out at 15s and is tried three times with backoff, so the
// window is roughly half a minute — and for all of it a member reading "Ready"
// was being told an affirmative thing about a gateway we had not reached.
// Worse, it is the same word the line shows when everything is fine but idle,
// so the state that most needs to be visible was the state that looked normal.
//
// Three statuses, three sentences. Saying "Checking…" costs nothing when the
// probe comes back in 200ms and is the truth when it does not.
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

const DAY = 86_400_000;

function ageLabel(at: number | undefined, now: number): string | undefined {
  if (at === undefined) return undefined;
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 60) return `${Math.max(1, minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/**
 * The Home ribbon's seat-first status fold. It accepts facts already read from
 * live gateway surfaces; no prototype fixtures or inferred security policy
 * live here. Missing facts make the sentence shorter, never more certain.
 */
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
  if (backupAge !== undefined && backupAge >= 2 * DAY) {
    const days = Math.floor(backupAge / DAY);
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

export interface AmbientStatusInput {
  /** The heartbeat monitor's verdict; `undefined` before the first read. */
  gatewayStatus: "unknown" | "up" | "down" | undefined;
  /** Approvals waiting on a human decision. */
  blockingCount: number;
  /** Unread notices in the inbox. */
  hasUnreadNotices: boolean;
}

/**
 * What the line says when nothing transient is showing.
 *
 * Work waiting on the member outranks reachability: a decision does not stop
 * being waiting because the gateway is slow to answer, and it is the one of the
 * three a member can act on.
 */
export function ambientStatusFor(input: AmbientStatusInput): string {
  const { blockingCount, gatewayStatus, hasUnreadNotices } = input;
  if (blockingCount > 0)
    return `${blockingCount} ${blockingCount === 1 ? "decision" : "decisions"} waiting on you`;
  if (hasUnreadNotices) return "New notices to read";
  if (gatewayStatus === "up") return "Synced";
  // The same sentence the offline banner and a refused commit control carry —
  // one condition, one explanation.
  if (gatewayStatus === "down") return OFFLINE_COMMIT_REASON;
  return "Checking…";
}
