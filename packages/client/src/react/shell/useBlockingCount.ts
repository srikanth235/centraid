import { useCallback, useEffect, useState } from "react";

import {
  getInbox,
  syncWebInboxNotifications,
  subscribeInboxChanges,
} from "../../gateway-client.js";

const POLL_MS = 60_000;

/**
 * Count of open decisions only. Notices use the Inbox's subtle unread dot and
 * never inflate this badge; SSE is primary and a 60s poll remains the fallback.
 */
export function useInboxCounts(): {
  decisionCount: number;
  hasUnreadNotices: boolean;
} {
  const [counts, setCounts] = useState({
    decisionCount: 0,
    hasUnreadNotices: false,
  });
  const load = useCallback(() => {
    void getInbox()
      .then((inbox) => {
        setCounts({
          decisionCount: inbox.decisions.count,
          hasUnreadNotices: inbox.unreadNoticeCount > 0,
        });
        void syncWebInboxNotifications().catch(() => undefined);
      })
      .catch(() => {
        // Gateway unreachable — keep the last known count rather than flapping.
      });
  }, []);
  useEffect(() => {
    load();
    const controller = new AbortController();
    void subscribeInboxChanges(load, controller.signal).catch(() => {
      // The slow poll below is the deliberate fallback.
    });
    const timer = window.setInterval(load, POLL_MS);
    window.addEventListener("focus", load);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", load);
      controller.abort();
    };
  }, [load]);
  return counts;
}

/** Compatibility accessor for callers that only render the decision badge. */
export function useBlockingCount(): number {
  return useInboxCounts().decisionCount;
}
