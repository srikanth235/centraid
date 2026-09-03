import { useCallback, useEffect, useState } from "react";

import {
  getNotifications,
  syncWebNotifications,
  subscribeNotificationsChanges,
} from "../../gateway-client.js";
import { startVisibilityTicker } from "./routes/visibility-ticker.js";

const POLL_MS = 60_000;

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
      .catch(() => {});
  }, []);
  useEffect(() => {
    load();
    const controller = new AbortController();
    void subscribeNotificationsChanges(load, controller.signal).catch(() => {});

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

export function useBlockingCount(): number {
  return useNotificationsCounts().decisionCount;
}
