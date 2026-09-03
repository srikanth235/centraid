import { useEffect, useState } from "react";

import type { GatewayRuntimeSnapshot } from "./routes/gatewayData.js";

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
      .catch(() => {});
    const off = window.CentraidApi.onGatewayRuntime?.(observe);
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  return status;
}

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
    void window.CentraidApi?.getGatewayRuntime?.()
      ?.then(observe)
      .catch(() => {});
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
    void window.CentraidApi?.getGatewayRuntime?.()
      ?.then((s) => {
        if (alive) setSnapshot(s);
      })
      .catch(() => {});
    const off = window.CentraidApi?.onGatewayRuntime?.((s) => setSnapshot(s));
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  return snapshot;
}
