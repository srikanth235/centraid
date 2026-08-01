import { useCallback, useEffect, useState } from "react";

import {
  getNotifications,
  syncWebNotifications,
  subscribeNotificationsChanges,
} from "../../gateway-client.js";
import { startVisibilityTicker } from "./routes/visibility-ticker.js";

const POLL_MS = 60_000;

/**
 * Count of open decisions only. Notices use the Notifications's subtle unread dot and
 * never inflate this badge; SSE is primary and a 60s poll remains the fallback.
 */
export function useNotificationsCounts(): {
  decisionCount: number;
  hasUnreadNotices: boolean;
} {
  const [counts, setCounts] = useState({
    decisionCount: 0,
    hasUnreadNotices: false,
  });
  const load = useCallback(() => {
    void getNotifications()
      .then((notifications) => {
        setCounts({
          decisionCount: notifications.decisions.count,
          hasUnreadNotices: notifications.unreadNoticeCount > 0,
        });
        void syncWebNotifications().catch(() => undefined);
      })
      .catch(() => {
        // Gateway unreachable — keep the last known count rather than flapping.
      });
  }, []);
  useEffect(() => {
    load();
    const controller = new AbortController();
    void subscribeNotificationsChanges(load, controller.signal).catch(() => {
      // The slow poll below is the deliberate fallback.
    });
    // The fallback poll suspends with the tab (issue #659): SSE is primary and
    // reconnects on return, and a hidden tab has no badge to keep current.
    const stop = startVisibilityTicker(load, POLL_MS);
    window.addEventListener("focus", load);
    return () => {
      stop();
      window.removeEventListener("focus", load);
      controller.abort();
    };
  }, [load]);
  return counts;
}

/** Compatibility accessor for callers that only render the decision badge. */
export function useBlockingCount(): number {
  return useNotificationsCounts().decisionCount;
}
