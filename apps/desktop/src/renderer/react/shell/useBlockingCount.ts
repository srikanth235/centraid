import { useCallback, useEffect, useState } from 'react';
import { getBlocking } from '../../gateway-client.js';

const POLL_MS = 60_000;

/**
 * Count of everything waiting on the owner (`GET /_vault/blocking`) for the
 * sidebar Approvals badge. No push channel exists for outbox/parked state, so
 * this polls on a slow interval and refreshes on window focus — decisions made
 * on the Approvals screen itself show there immediately; the badge catches up
 * within a poll tick.
 */
export function useBlockingCount(): number {
  const [count, setCount] = useState(0);
  const load = useCallback(() => {
    void getBlocking()
      .then((b) =>
        setCount(
          b.outbox.length + b.needsAuth.length + b.parked.length + b.scopeRequests.length,
        ),
      )
      .catch(() => {
        // Gateway unreachable — keep the last known count rather than flapping.
      });
  }, []);
  useEffect(() => {
    load();
    const timer = window.setInterval(load, POLL_MS);
    window.addEventListener('focus', load);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', load);
    };
  }, [load]);
  return count;
}
