export interface MobileInboxNotificationPull {
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

export interface MobileInboxNotificationRow {
  key: string;
  title: string;
  body: string;
}

/** Private Inbox content becomes notification text only on the paired device. */
export function composeMobileInboxNotifications(
  inbox: MobileInboxNotificationPull,
  delivered: ReadonlySet<string>
): MobileInboxNotificationRow[] {
  return [
    ...inbox.decisions.outbox.map((row) => ({
      key: `outbox:${row.itemId}:${row.stagedAt}`,
      title:
        ["title", "subject", "name"]
          .map((key) => row.artifact[key])
          .find((value): value is string => typeof value === "string") ??
        row.target,
      body: "External write needs your approval",
    })),
    ...inbox.decisions.needsAuth.map((row) => ({
      key: `auth:${row.connectionId}:${row.attentionAt}`,
      title: `${row.label} needs reconnection`,
      body: "Open Inbox to reconnect",
    })),
    ...inbox.decisions.parked.map((row) => ({
      key: `parked:${row.invocationId}`,
      title: row.command,
      body: "A decision is waiting in Inbox",
    })),
    ...inbox.decisions.scopeRequests.map((row) => ({
      key: `scope:${row.requestId}`,
      title: `${row.appId} requests access`,
      body: "Review the requested scope in Inbox",
    })),
    ...inbox.notices
      .filter(
        (notice) =>
          notice.severity === "high" &&
          notice.readAt === null &&
          notice.archivedAt === null
      )
      .map((notice) => ({
        key: `notice:${notice.noticeId}:${notice.lastAt}`,
        title: notice.headline,
        body: "Open Inbox for details",
      })),
  ].filter((row) => !delivered.has(row.key));
}
