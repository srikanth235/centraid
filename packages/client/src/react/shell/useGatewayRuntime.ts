import { useEffect, useState } from "react";

import type { GatewayRuntimeSnapshot } from "./routes/gatewayData.js";

// Live view of the main-process gateway heartbeat monitor: one read for
// first paint, then the per-poll push stream (every ~5s, plus immediately
// after settings writes / gateway switches). Used by the Gateway route for
// the page itself and by App for the sidebar status pill — each consumer
// holds its own cheap subscription.
/**
 * Just the reachability verdict, re-rendering ONLY when it actually changes
 * (issue #659).
 *
 * The monitor broadcasts a full snapshot every 5 seconds, and most of it moves
 * every tick by design — latency, uptime, the probe strip, the check counters.
 * The Gateway page renders those and wants them. The shell root does not: it
 * shows a status pill and an offline banner. Subscribing it to the whole
 * snapshot meant a heartbeat re-rendered the ENTIRE active screen every five
 * seconds forever, for a value that changes when the network does.
 *
 * Gating here rather than in the main-process broadcast is deliberate: the
 * snapshot legitimately differs every tick, so a change-gate upstream would
 * either never fire or freeze the live page that depends on it. The cost worth
 * removing is the re-render, and this removes it without withholding data from
 * the consumer that wants it.
 */
export function useGatewayStatus():
  | GatewayRuntimeSnapshot["status"]
  | undefined {
  const [status, setStatus] = useState<
    GatewayRuntimeSnapshot["status"] | undefined
  >(undefined);
  useEffect(() => {
    let alive = true;
    // `setState` with an unchanged primitive is a no-op in React, so the
    // narrowing to one field IS the gate.
    const observe = (snapshot: GatewayRuntimeSnapshot): void =>
      setStatus(snapshot.status);
    window.CentraidApi.getGatewayRuntime?.()
      .then((snapshot) => {
        if (alive) observe(snapshot);
      })
      .catch(() => {
        /* first read racing app boot — the push stream covers us */
      });
    const off = window.CentraidApi.onGatewayRuntime?.(observe);
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  return status;
}

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
