import { useCallback, useState } from "react";

import { Store } from "./store.js";

// Who owns the phone's bottom band for one app (Photos v4, CHANGELOG F).
//
// The brief lists `bandOwner` as MEMBER-RECORD state — a member who prefers
// the host band means it on every device and for longer than a session. This
// installation has no server-side member preference surface: every per-member
// UI preference in the shell (launcher pins, starred apps, appearance, the
// stem's open state) persists through the client-local `Store`, and inventing
// a second persistence path for one enum would be the divergence
// docs/config-ownership.md exists to prevent. So it goes through `Store`, on
// the same terms as `usePins`. When a real member record lands, this hook is
// the one place that has to change.
//
// It is keyed PER APP, not globally: the claim is a property of the route that
// makes it, and a member who wants the host band back in Photos has said
// nothing about the next app that claims. Nothing here is keyed on vault or
// gateway — which band a phone shows is not vault-scoped state
// (docs/client-keying.md: prefer no key over a key that churns).

export type BandOwner = "app" | "host";

/** Default: the app's band. A first-party route that claims it has shelves the
 *  frame's five destinations cannot carry, and the capsule keeps the way out
 *  at thumb level either way. */
const DEFAULT_OWNER: BandOwner = "app";

const key = (appId: string): string => `shell.bandOwner.${appId}`;

/** Read the stored owner outside React (route hosts, tests). */
export function readBandOwner(appId: string): BandOwner {
  return Store.get<BandOwner>(key(appId), DEFAULT_OWNER);
}

export function useBandOwner(appId: string): {
  bandOwner: BandOwner;
  setBandOwner: (owner: BandOwner) => void;
} {
  // The stored app is carried IN the state, so switching route to another app
  // re-reads that app's preference during the same render rather than showing
  // the previous app's answer for one frame. (React's documented
  // adjust-state-on-prop-change pattern — no effect, so no flash.)
  const [held, setHeld] = useState<{ appId: string; owner: BandOwner }>(() => ({
    appId,
    owner: readBandOwner(appId),
  }));
  if (held.appId !== appId) {
    setHeld({ appId, owner: readBandOwner(appId) });
  }

  const setBandOwner = useCallback(
    (owner: BandOwner) => {
      Store.set(key(appId), owner);
      setHeld({ appId, owner });
    },
    [appId]
  );

  return {
    bandOwner: held.appId === appId ? held.owner : readBandOwner(appId),
    setBandOwner,
  };
}
