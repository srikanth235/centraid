import { useCallback, useEffect, useState } from 'react';
import { listVaults, type VaultListEntry } from '../../gateway-client.js';
import { useAsyncData } from './useAsyncData.js';

// The sidebar-head vault registry, ported from the vanilla app.ts
// `refreshVaultProfiles` + `isActiveVault` pair. Since #289 the client owns
// the vault pointer (there is no server-side "active" flag) — the addressed
// vault is whatever `getGatewayAuth().vaultId` resolves to, falling back to
// the first vault the registry returns (the gateway's default). Re-fetches
// on any vault/gateway change broadcast so the head stays in lockstep with
// Settings → Spaces, phone-linked switches, and other devices.

interface VaultRegistrySnapshot {
  vaults: VaultListEntry[];
  activeVaultId: string;
}

async function loadVaultRegistry(): Promise<VaultRegistrySnapshot> {
  const [list, auth] = await Promise.all([
    listVaults().catch(() => undefined),
    window.CentraidApi.getGatewayAuth().catch(() => ({ baseUrl: '', vaultId: undefined })),
  ]);
  const vaults = list ?? [];
  return { vaults, activeVaultId: auth.vaultId ?? vaults[0]?.vaultId ?? '' };
}

export interface ActiveVaultController {
  /** Every vault this client can address on the active gateway. */
  vaults: VaultListEntry[];
  /** The vault this client currently addresses — undefined until resolved
   *  (first paint) or if the gateway mounts no vault plane. */
  active: VaultListEntry | undefined;
  activeVaultId: string;
  /** True until the first fetch settles (success or failure). */
  loading: boolean;
  /** Re-root the client at a different vault (issue #289). Fires
   *  `onVaultChanged`, which this hook also listens for, so the switch
   *  round-trips back into `active` once the gateway acks it. */
  switchVault: (vaultId: string) => void;
}

export function useActiveVault(): ActiveVaultController {
  const [nonce, setNonce] = useState(0);
  const state = useAsyncData(loadVaultRegistry, [nonce]);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const offVault = window.CentraidApi.onVaultChanged?.(refresh);
    const offGateway = window.CentraidApi.onGatewayChanged?.(refresh);
    return () => {
      offVault?.();
      offGateway?.();
    };
  }, [refresh]);

  const vaults = state.status === 'ready' ? state.data.vaults : [];
  const activeVaultId = state.status === 'ready' ? state.data.activeVaultId : '';
  const active = vaults.find((v) => v.vaultId === activeVaultId);

  const switchVault = useCallback((vaultId: string) => {
    void window.CentraidApi.setActiveVault({ vaultId });
  }, []);

  return { vaults, active, activeVaultId, loading: state.status === 'loading', switchVault };
}
