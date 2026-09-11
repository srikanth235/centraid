// How many alerts need a look, for Activity overview's standing way into the
// alerts view (#1015 R-NY-2). One read of the notices plus the notifications
// doorbell; a read that fails says nothing (`undefined`) rather than zero —
// "Nothing needs a look" over an unreachable gateway would be a false calm.

import { useEffect, useState } from "react";

import {
  getNotifications,
  subscribeMobileNotificationsChanges,
} from "../../lib/gateway";
import { needsALookCount } from "./alerts-model";

export function useAlertCount(): number | undefined {
  const [count, setCount] = useState<number | undefined>();
  useEffect(() => {
    let live = true;
    const read = (): void => {
      void getNotifications()
        .then((notifications) => {
          if (live) setCount(needsALookCount(notifications.notices));
        })
        .catch(() => {
          if (live) setCount(undefined);
        });
    };
    read();
    const controller = new AbortController();
    void subscribeMobileNotificationsChanges(read, controller.signal).catch(
      () => undefined
    );
    return () => {
      live = false;
      controller.abort();
    };
  }, []);
  return count;
}
