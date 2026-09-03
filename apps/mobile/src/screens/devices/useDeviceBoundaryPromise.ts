import { useEffect, useState } from "react";

import { parseLociBody } from "@centraid/client/access-lens";

import { useReplica } from "../../kit/replica/ReplicaProvider";
import { nativeGrantWire } from "../../kit/share/grant-seat";

export function useDeviceBoundaryPromise(): string {
  const replica = useReplica();
  const base = replica.gatewayBase ?? "";
  const [promise, setPromise] = useState("");
  useEffect(() => {
    if (!base) return undefined;
    let cancelled = false;
    void nativeGrantWire(base)
      .subjects()
      .then((body) => {
        if (!cancelled) setPromise(parseLociBody(body).boundary ?? "");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [base]);
  return promise;
}
