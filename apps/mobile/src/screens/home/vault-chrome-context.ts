// The context alone, in its own module so `VaultBar` can reach the open
// handlers without importing the provider — and therefore without pulling the
// launcher catalog, the blueprint search index and the gateway client into
// every app frame that draws a header.

import { createContext, useContext } from "react";

export interface VaultChrome {
  openSearch: () => void;
  openVaults: () => void;
  /** Routed by the provider, which owns the navigator — see `VaultBar`. */
  openNewChat: () => void;
}

/** A no-op default, never a throw: a surface rendered outside the provider
 *  (a test harness, a modal root) should draw its header, not crash. */
export const VaultChromeContext = createContext<VaultChrome>({
  openNewChat: () => undefined,
  openSearch: () => undefined,
  openVaults: () => undefined,
});

export function useVaultChrome(): VaultChrome {
  return useContext(VaultChromeContext);
}
