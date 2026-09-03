import { useCallback, useEffect, useState } from "react";

import { Store } from "../../storage";

export type BandOwner = "app" | "host";

export const DEFAULT_BAND_OWNER: BandOwner = "app";

export const bandOwnerKey = (appId: string): string =>
  `shell.bandOwner.${appId}`;

export function asBandOwner(value: unknown): BandOwner {
  return value === "host" ? "host" : "app";
}

export function writeBandOwner(appId: string, owner: BandOwner): void {
  Store.set(bandOwnerKey(appId), owner);
}

export interface BandClaimingApp {
  id: string;
  name: string;
}

export const BAND_CLAIMING_APPS: readonly BandClaimingApp[] = [
  { id: "photos", name: "Photos" },
  { id: "docs", name: "Docs" },
  { id: "people", name: "People" },
  { id: "agenda", name: "Agenda" },
  { id: "tasks", name: "Tasks" },
  { id: "locker", name: "Locker" },
  { id: "tally", name: "Tally" },
  { id: "notes", name: "Notes" },
];

export interface BandOwnerState {
  bandOwner: BandOwner;
  setBandOwner: (owner: BandOwner) => void;
}

export function useBandOwner(appId: string): BandOwnerState {
  const [owner, setOwner] = useState<BandOwner>(DEFAULT_BAND_OWNER);
  useEffect(() => {
    let live = true;
    void Store.hydrate(bandOwnerKey(appId), DEFAULT_BAND_OWNER).then(
      (stored) => {
        if (live) setOwner(asBandOwner(stored));
      }
    );
    return () => {
      live = false;
    };
  }, [appId]);

  const setBandOwner = useCallback(
    (next: BandOwner) => {
      writeBandOwner(appId, next);
      setOwner(next);
    },
    [appId]
  );

  return { bandOwner: owner, setBandOwner };
}
