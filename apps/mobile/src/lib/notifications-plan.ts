import {
  NOTIFY_NEEDS_AUTH_BODY,
  NOTIFY_NOTICE_BODY,
  NOTIFY_OUTBOX_BODY,
  NOTIFY_PARKED_BODY,
  NOTIFY_SCOPE_BODY,
} from "@centraid/client/notifications-copy";

export interface MobileNotificationsPull {
  decisions: {
    outbox: Array<{
      itemId: string;
      target: string;
      artifact: Record<string, unknown>;
      stagedAt: string;
    }>;
    needsAuth: Array<{
      connectionId: string;
      label: string;
      attentionAt: string;
    }>;
    parked: Array<{ invocationId: string; command: string }>;
    scopeRequests: Array<{ requestId: string; appId: string }>;
  };
  notices: Array<{
    noticeId: string;
    headline: string;
    severity: "info" | "warning" | "high";
    lastAt: string;
    readAt: string | null;
    archivedAt: string | null;
  }>;
}

export interface MobileNotificationRow {
  key: string;
  title: string;
  body: string;
}

/** Private Notifications content becomes notification text only on the paired device. */
export function composeMobileNotifications(
  notifications: MobileNotificationsPull,
  delivered: ReadonlySet<string>
): MobileNotificationRow[] {
  return [
    ...notifications.decisions.outbox.map((row) => ({
      key: `outbox:${row.itemId}:${row.stagedAt}`,
      title:
        ["title", "subject", "name"]
          .map((key) => row.artifact[key])
          .find((value): value is string => typeof value === "string") ??
        row.target,
      body: NOTIFY_OUTBOX_BODY,
    })),
    ...notifications.decisions.needsAuth.map((row) => ({
      key: `auth:${row.connectionId}:${row.attentionAt}`,
      title: `${row.label} needs reconnection`,
      body: NOTIFY_NEEDS_AUTH_BODY,
    })),
    ...notifications.decisions.parked.map((row) => ({
      key: `parked:${row.invocationId}`,
      title: row.command,
      body: NOTIFY_PARKED_BODY,
    })),
    ...notifications.decisions.scopeRequests.map((row) => ({
      key: `scope:${row.requestId}`,
      title: `${row.appId} requests access`,
      body: NOTIFY_SCOPE_BODY,
    })),
    ...notifications.notices
      .filter(
        (notice) =>
          notice.severity === "high" &&
          notice.readAt === null &&
          notice.archivedAt === null
      )
      .map((notice) => ({
        key: `notice:${notice.noticeId}:${notice.lastAt}`,
        title: notice.headline,
        body: NOTIFY_NOTICE_BODY,
      })),
  ].filter((row) => !delivered.has(row.key));
}

/** What one `syncNotifications` pass should do. */
export interface NotificationPlan {
  notifications: MobileNotificationRow[];
  nextDelivered?: string[];
  seeded: boolean;
}

/** Device-side delivery ledger bound; oldest keys fall off first. */
const LEDGER_LIMIT = 2_000;

/**
 * Decide what a sync pass does, with no I/O (#647). Two rules, easy to lose:
 * seed silently (first pass records the baseline, notifies nothing); never
 * notify over the owner's shoulder (foreground passes leave the ledger alone,
 * so on-screen arrivals still notify on the next background wake).
 */
export function planNotifications(input: {
  notifications: MobileNotificationsPull;
  delivered: readonly string[];
  seeded: boolean;
  appActive: boolean;
}): NotificationPlan {
  const candidates = composeMobileNotifications(input.notifications, new Set());
  if (!input.seeded) {
    return {
      notifications: [],
      nextDelivered: [
        ...new Set([...input.delivered, ...candidates.map((row) => row.key)]),
      ].slice(-LEDGER_LIMIT),
      seeded: true,
    };
  }
  if (input.appActive) return { notifications: [], seeded: false };
  const delivered = new Set(input.delivered);
  const notifications = candidates.filter((row) => !delivered.has(row.key));
  if (notifications.length === 0) return { notifications, seeded: false };
  for (const row of notifications) delivered.add(row.key);
  return {
    notifications,
    nextDelivered: [...delivered].slice(-LEDGER_LIMIT),
    seeded: false,
  };
}
