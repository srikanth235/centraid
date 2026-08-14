// The capability seam's React half (C1, docs/platform-gating.md).
//
// One read of the gateway's info handshake per shell boot, published once in
// context. Every gated surface — the launcher, the ⌘K palette, the ops bar's
// verbs, the route wall, the per-app settings tabs, the editor's connectors
// picker — reads THIS. Nothing re-fetches, and nothing re-derives "is this
// gateway an automations gateway" from a failed request of its own, which is
// what "detection in exactly one place" means in practice.
//
// The pure half — the shape, the safe defaults, the route table — is
// `capabilities.ts`.
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

/** Wraps the shell. Anything inside can ask what this gateway offers without
 *  knowing there is a handshake. */
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

/**
 * What this gateway offers.
 *
 * Outside a provider everything is ON, for the same reason an unprovided
 * commit availability is "allowed" (`commitAvailability.tsx`): the absence of a
 * provider is an unmounted subtree or a screen under test, not a gateway that
 * said no, and defaulting to "refuse" there would make every such tree look
 * like a stripped-down gateway. The shell root always publishes a real value,
 * and that value starts OFF until the handshake answers.
 */
export function useShellCapabilities(): ShellCapabilities {
  return useContext(CapabilitiesContext);
}

export interface GatewayCapabilitiesState {
  capabilities: ShellCapabilities;
  /** Whether the handshake has answered. False is the boot window, not a
   *  verdict — a route wall rendered during it would accuse a gateway that has
   *  not spoken yet. */
  resolved: boolean;
}

/**
 * Read the active gateway's capability map once, and again whenever the
 * gateway or vault changes — a different gateway is a different opt-in, so a
 * switch that kept the previous answer would leave Automations standing in the
 * stem of a gateway that never mounted it.
 *
 * A failed read (offline, an older host, a partial bridge in tests) leaves the
 * gates off and RESOLVED: an unreachable gateway cannot promise a surface, and
 * hanging the wall in its loading frame forever would be a silent no-op.
 */
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
