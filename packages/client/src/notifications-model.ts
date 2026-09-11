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
  /** What the push is ABOUT, so a tap lands where it can be acted on
   *  (#1015 R-NY-16, mirroring the phone's `notifications-plan.ts`): a
   *  decision opens Needs you, a notice opens Activity. The wake relay is
   *  content-free, so this composer is the only place the difference is known. */
  about: "decision" | "notice";
}

/**
 * Where a tapped push lands. The web seat has no alerts view inside Activity
 * (the phone's alerts tab has no web counterpart), so a notice opens Activity
 * itself. `App.tsx` reads these two query keys; `apps/web/public/sw.js`
 * mirrors them for background delivery.
 */
export function notificationTarget(about: NotificationRow["about"]): string {
  return about === "decision" ? "/?needs-you=1" : "/?activity=1";
}

/**
 * Compose private notification content after the authenticated Notifications fetch.
 * Decision keys include the canonical transition timestamp so an outbox
 * re-park or a later needs-auth episode can notify again without duplicating
 * a still-open decision.
 */
export function composeWebNotifications(
  notifications: NotificationsPull,
  delivered: ReadonlySet<string>
): NotificationRow[] {
  const decisions: NotificationRow[] = [
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
  ].map((row) => ({ ...row, about: "decision" as const }));
  const notices: NotificationRow[] = notifications.notices
    .filter(
      (notice) =>
        notice.severity === "high" &&
        notice.readAt === null &&
        notice.archivedAt === null
    )
    .map((notice) => ({
      about: "notice" as const,
      body: NOTIFY_NOTICE_BODY,
      key: `notice:${notice.noticeId}:${notice.lastAt}`,
      title: notice.headline,
    }));
  return [...decisions, ...notices].filter((row) => !delivered.has(row.key));
}
