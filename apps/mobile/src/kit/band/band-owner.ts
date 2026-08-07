// WHO OWNS THE BAND, PER APP — the frame's latch (issue #712 E3).
//
// This used to live inside Photos (`apps/photos/photos-band.ts`), under the
// key `photos.bandOwner.<appId>`, while the shipped web shell kept the same
// concept under `shell.bandOwner.<appId>`
// (`packages/client/src/react/shell/useBandOwner.ts`). Two namespaces for one
// preference, in an app directory, for a decision the FRAME makes: the phone
// could not have answered "has any app claimed the band" without importing
// Photos, and `kit`/`screens` may not import an app
// (`scripts/check-import-boundaries.ts`).
//
// THE NAMESPACE IS NOW `shell.bandOwner.<appId>`, MATCHING WEB. Mobile adopted
// web's spelling rather than the reverse because the web key is the one that
// already names the owner of the concept (the shell), and because the web
// hook's storage is the surface a future shared core would keep. The cost is
// stated plainly: any answer a member had already stored under
// `photos.bandOwner.*` on a device is NOT migrated and silently reverts to the
// default (`app`). That is acceptable only because nothing shipped could WRITE
// that key — `setBandOwner` had no caller on either client, which is the
// defect this change fixes — so the only stored values in the world are ones a
// developer put there by hand. If a writer had shipped, this would need a
// read-through migration instead.
//
// Per app, not global, for the reason web's hook gives: a member who wants the
// host band back in Photos has said nothing about the next app that claims.
// Nothing here is keyed on vault or gateway — which band a phone shows is not
// vault-scoped state (docs/client-keying.md: prefer no key over a key that
// churns).

import { useCallback, useEffect, useState } from "react";

import { Store } from "../../storage";

export type BandOwner = "app" | "host";

/** Default: the claiming app's band. A first-party route that claims it has
 *  shelves the frame's five destinations cannot carry, and the capsule keeps
 *  the way out at thumb level either way. */
export const DEFAULT_BAND_OWNER: BandOwner = "app";

/** Where a member's band-owner choice lives on this device. */
export const bandOwnerKey = (appId: string): string =>
  `shell.bandOwner.${appId}`;

/** Narrow a hydrated value — the store is JSON, so anything could be in it. */
export function asBandOwner(value: unknown): BandOwner {
  return value === "host" ? "host" : "app";
}

/** Write the answer without a component — for a settings row that owns the
 *  list rather than one app's mount. */
export function writeBandOwner(appId: string, owner: BandOwner): void {
  Store.set(bandOwnerKey(appId), owner);
}

/** One app the frame knows can claim the band. */
export interface BandClaimingApp {
  id: string;
  name: string;
}

/**
 * The apps that claim a band today — ONE, and the frame says so rather than
 * pretending otherwise.
 *
 * This is a hand-maintained roster, not a derived fact, and that is a real
 * limitation worth stating: mobile has no inline-app channel like web's
 * `frame.claimBand`, so an app's claim is a component it renders
 * (`PhotosBand.tsx`), not something the frame can enumerate. The frame cannot
 * ASK who has claimed, so the settings list has to be told. A second claiming
 * app must add its row here in the same change that adds its band — which is
 * the same shape of hand-maintained mirror `placement-registry.ts` and
 * `consent-gate.ts`'s `ENRICH_DOMAINS` already are, and it is why the
 * band-owner latch itself is keyed by an arbitrary `appId` rather than being
 * hard-wired to Photos: the mechanism is general even while the roster is one
 * row long.
 */
export const BAND_CLAIMING_APPS: readonly BandClaimingApp[] = [
  { id: "photos", name: "Photos" },
];

export interface BandOwnerState {
  bandOwner: BandOwner;
  setBandOwner: (owner: BandOwner) => void;
}

/**
 * The hook every band-claiming surface reads. Hydrates once per app id, then
 * writes through both the store and local state so a second surface in the
 * same stack sees the change on its next mount.
 */
export function useBandOwner(appId: string): BandOwnerState {
  // Starts at the DEFAULT and hydrates, rather than reading the store's warm
  // cache synchronously. A band that flickered to nothing while an await
  // resolved would be worse than one that starts claimed and stays claimed,
  // and this is the behaviour the two Photos screens already had before the
  // latch moved here — the move is about ownership and the key, not about
  // changing what the first frame paints.
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
