import {
  NOTIFY_NEEDS_AUTH_BODY,
  NOTIFY_NOTICE_BODY,
  NOTIFY_OUTBOX_BODY,
  NOTIFY_PARKED_BODY,
  NOTIFY_SCOPE_BODY,
} from "./notifications-copy.js";

export interface NotificationsPull {
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

export interface NotificationRow {
  key: string;
  title: string;
  body: string;
}

export function composeWebNotifications(
  notifications: NotificationsPull,
  delivered: ReadonlySet<string>
): NotificationRow[] {
  return [
    ...notifications.decisions.outbox.map((row) => ({
      key: `outbox:${row.itemId}:${row.stagedAt}`,
      title:
        ["title", "subject", "name"]
          .map((field) => row.artifact[field])
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
