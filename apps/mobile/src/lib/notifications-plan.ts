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
      body: "External write needs your approval",
    })),
    ...notifications.decisions.needsAuth.map((row) => ({
      key: `auth:${row.connectionId}:${row.attentionAt}`,
      title: `${row.label} needs reconnection`,
      body: "Open Notifications to reconnect",
    })),
    ...notifications.decisions.parked.map((row) => ({
      key: `parked:${row.invocationId}`,
      title: row.command,
      body: "A decision is waiting in Notifications",
    })),
    ...notifications.decisions.scopeRequests.map((row) => ({
      key: `scope:${row.requestId}`,
      title: `${row.appId} requests access`,
      body: "Review the requested scope in Notifications",
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
        body: "Open Notifications for details",
      })),
  ].filter((row) => !delivered.has(row.key));
}

/** What one `syncNotifications` pass should do. */
export interface NotificationPlan {
  /** OS notifications to schedule now (empty on a seed or foreground pass). */
  notifications: MobileNotificationRow[];
  /** Ledger to persist, or `undefined` to leave the stored ledger untouched. */
  nextDelivered?: string[];
  /** True when this pass established the baseline instead of notifying. */
  seeded: boolean;
}

/** Bound on the device-side delivery ledger; oldest keys fall off first. */
const LEDGER_LIMIT = 2_000;

/**
 * Decide what a sync pass does, with no I/O (#647 review of PR #655).
 *
 * Two rules the old inline logic was missing:
 *
 *  1. **Seed silently.** The ledger starts absent, so the very first sync after
 *     a grant treated every already-open decision as new and fired one banner
 *     per row. A first pass now records the current payload as the baseline and
 *     notifies about nothing; only what appears *after* it is news.
 *  2. **Never notify over the owner's shoulder.** With the app active the Notifications
 *     itself is on screen, so a banner is noise. A foreground pass leaves the
 *     ledger alone — deliberately, so anything that arrived while the owner was
 *     looking still notifies on the next background wake if it is still waiting.
 *
 * `seeded` is tracked outside the ledger array so that an empty baseline (a
 * quiet Notifications at grant time) is not mistaken for "never seeded", which would
 * swallow the first real decision instead of announcing it.
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
