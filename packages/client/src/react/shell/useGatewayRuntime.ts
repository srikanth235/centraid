import { useEffect, useState } from "react";

import type { GatewayRuntimeSnapshot } from "./routes/gatewayData.js";

/**
 * Reachability only; re-render ONLY when it changes (#659).
 *
 * The monitor broadcasts a full snapshot every 5s, and most of it moves every
 * tick (latency, uptime, probe strip). The Gateway page wants that. The shell
 * root shows a pill and an offline banner — subscribing it to the whole
 * snapshot re-rendered the entire active screen every five seconds.
 *
 * Gate here, not in the main-process broadcast: the snapshot legitimately
 * differs every tick, so an upstream change-gate would never fire or would
 * freeze the live page. This removes the re-render without withholding data.
 */
export function useGatewayStatus():
  | GatewayRuntimeSnapshot["status"]
  | undefined {
  const [status, setStatus] = useState<
    GatewayRuntimeSnapshot["status"] | undefined
  >(undefined);
  useEffect(() => {
    let alive = true;
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

/** Last heartbeat time + whether it answered. Same #659 narrowing as
 *  {@link useGatewayStatus}: the foot re-renders; the shell root does not. */
export function useGatewayCheck(): {
  status: GatewayRuntimeSnapshot["status"] | undefined;
  lastCheckAt: number | undefined;
} {
  const [check, setCheck] = useState<{
    status: GatewayRuntimeSnapshot["status"] | undefined;
    lastCheckAt: number | undefined;
  }>({ lastCheckAt: undefined, status: undefined });
  useEffect(() => {
    let alive = true;
    const observe = (snapshot: GatewayRuntimeSnapshot): void => {
      if (!alive) return;
      setCheck((prev) =>
        prev.status === snapshot.status &&
        prev.lastCheckAt === snapshot.lastCheckAt
          ? prev
          : { lastCheckAt: snapshot.lastCheckAt, status: snapshot.status }
      );
    };
    // Optional-chained THREE deep, each load-bearing: `CentraidApi` is absent
    // in a test harness and on web before boot; the method is absent on a host
    // that does not expose the runtime; the CALL's result is absent whenever
    // the method is. Chaining only the method threw TypeError out of an effect
    // on every surface that lacks the bridge.
    void window.CentraidApi?.getGatewayRuntime?.()
      ?.then(observe)
      .catch(() => {
        /* first read racing app boot — the push stream covers us */
      });
    const off = window.CentraidApi?.onGatewayRuntime?.(observe);
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  return check;
}

export function useGatewayRuntime(): GatewayRuntimeSnapshot | null {
  const [snapshot, setSnapshot] = useState<GatewayRuntimeSnapshot | null>(null);
  useEffect(() => {
    let alive = true;
    // Same three-link chain as `useGatewayCheck` — partial/absent CentraidApi
    // in test harnesses.
    void window.CentraidApi?.getGatewayRuntime?.()
      ?.then((s) => {
        if (alive) setSnapshot(s);
      })
      .catch(() => {
        /* first read racing app boot — the push stream covers us */
      });
    const off = window.CentraidApi?.onGatewayRuntime?.((s) => setSnapshot(s));
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  return snapshot;
}
