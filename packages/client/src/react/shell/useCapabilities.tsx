// C1: one handshake read. Nothing re-derives "automations gateway" on its own.
import { createContext, useContext, useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";

import { readGatewayCapabilities } from "../../gateway-client.js";
import {
  CAPABILITIES_OFF,
  CAPABILITIES_ON,
  shellCapabilitiesFrom,
} from "./capabilities.js";
import type { ShellCapabilities } from "./capabilities.js";

const CapabilitiesContext = createContext<ShellCapabilities>(CAPABILITIES_ON);

export function CapabilitiesProvider({
  value,
  children,
}: {
  value: ShellCapabilities;
  children: ReactNode;
}): JSX.Element {
  return (
    <CapabilitiesContext.Provider value={value}>
      {children}
    </CapabilitiesContext.Provider>
  );
}

// Outside a provider everything is ON — unmounted/test, not a gateway that said no.
export function useShellCapabilities(): ShellCapabilities {
  return useContext(CapabilitiesContext);
}

export interface GatewayCapabilitiesState {
  capabilities: ShellCapabilities;
  resolved: boolean;
}

// Re-read on gateway/vault change. Failed read → off and resolved, not hung.
export function useGatewayCapabilities(): GatewayCapabilitiesState {
  const [state, setState] = useState<GatewayCapabilitiesState>({
    capabilities: CAPABILITIES_OFF,
    resolved: false,
  });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const bump = (): void => setNonce((n) => n + 1);
    const offGateway = window.CentraidApi.onGatewayChanged?.(bump);
    const offVault = window.CentraidApi.onVaultChanged?.(bump);
    return () => {
      offGateway?.();
      offVault?.();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void readGatewayCapabilities()
      .catch(() => undefined)
      .then((map) => {
        if (!alive) return;
        setState({ capabilities: shellCapabilitiesFrom(map), resolved: true });
      });
    return () => {
      alive = false;
    };
  }, [nonce]);

  return state;
}
