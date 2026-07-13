import { useEffect, useState } from 'react';
import type { GatewayRuntimeSnapshot } from './routes/gatewayData.js';

// Live view of the main-process gateway heartbeat monitor: one read for
// first paint, then the per-poll push stream (every ~5s, plus immediately
// after settings writes / gateway switches). Used by the Gateway route for
// the page itself and by App for the sidebar status pill — each consumer
// holds its own cheap subscription.
export function useGatewayRuntime(): GatewayRuntimeSnapshot | null {
  const [snapshot, setSnapshot] = useState<GatewayRuntimeSnapshot | null>(null);
  useEffect(() => {
    let alive = true;
    // Optional-chained like onGatewayChanged in App.tsx — test harnesses
    // stub CentraidApi partially.
    window.CentraidApi.getGatewayRuntime?.()
      .then((s) => {
        if (alive) setSnapshot(s);
      })
      .catch(() => {
        /* first read racing app boot — the push stream covers us */
      });
    const off = window.CentraidApi.onGatewayRuntime?.((s) => setSnapshot(s));
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  return snapshot;
}
