import { createContext, useContext } from "react";

export interface VaultChrome {
  openSearch: () => void;
  openVaults: () => void;
  openNewChat: () => void;
}

export const VaultChromeContext = createContext<VaultChrome>({
  openNewChat: () => undefined,
  openSearch: () => undefined,
  openVaults: () => undefined,
});

export function useVaultChrome(): VaultChrome {
  return useContext(VaultChromeContext);
}
