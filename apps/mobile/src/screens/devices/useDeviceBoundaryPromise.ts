import { useEffect, useState } from "react";

import { parseLociBody } from "@centraid/client/access-lens";

import { useReplica } from "../../kit/replica/ReplicaProvider";
import { nativeGrantWire } from "../../kit/share/grant-seat";

/**
 * What revoking a DEVICE can promise, in the vault's own words (#883, ruling
 * V-locus): a device is enforced at the boundary it authenticates through, so
 * the sentence has two halves — the door refuses it from now on, and what it
 * already holds stays with it — and the second half is exactly the one a seat
 * must never write for itself.
 *
 * `""` while unread or unreachable, so the surface says NOTHING rather than a
 * promise the vault did not make.
 */
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
