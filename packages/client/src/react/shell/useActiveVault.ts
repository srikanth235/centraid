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
  /** The gateway this client currently addresses — undefined only when
   *  `getSettings` itself is unavailable (stubbed test bridges). */
  activeGatewayId: string | undefined;
  activeGatewayLabel: string | undefined;
  activeGatewayKind: 'local' | 'remote' | undefined;
}

async function loadVaultRegistry(): Promise<VaultRegistrySnapshot> {
  const [list, auth, settings] = await Promise.all([
    listVaults().catch(() => undefined),
    window.CentraidApi.getGatewayAuth().catch(() => ({ baseUrl: '', vaultId: undefined })),
    window.CentraidApi.getSettings?.().catch(() => undefined),
  ]);
  const vaults = list ?? [];
  return {
    vaults,
    activeVaultId: auth.vaultId ?? vaults[0]?.vaultId ?? '',
    activeGatewayId: settings?.activeGatewayId,
    activeGatewayLabel: settings?.activeGatewayLabel,
    activeGatewayKind: settings?.activeGatewayKind,
  };
}

export interface ActiveVaultController {
  /** Every vault this client can address on the active gateway. */
  vaults: VaultListEntry[];
  /** The vault this client currently addresses — undefined until resolved
   *  (first paint) or if the gateway mounts no vault plane. */
  active: VaultListEntry | undefined;
  activeVaultId: string;
  /** The active gateway's id/label/kind (issue #376) — feeds the flat
   *  switcher's "which pair is current" check and the sidebar head's
   *  gateway hint. Undefined only while loading or if `getSettings` is
   *  unavailable (stubbed test bridges). */
  activeGatewayId: string | undefined;
  activeGatewayLabel: string | undefined;
  activeGatewayKind: 'local' | 'remote' | undefined;
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
    // Metadata-only changes (Settings -> Space rename/retheme, issue #382
    // follow-up) — separate from onVaultChanged/onGatewayChanged so a save
    // here refreshes the sidebar head WITHOUT tripping App.tsx's `reScope`
    // (which treats onVaultChanged as "the addressed vault changed" and
    // navigates Home).
    const offMetadata = window.CentraidApi.onVaultMetadataChanged?.(refresh);
    return () => {
      offVault?.();
      offGateway?.();
      offMetadata?.();
    };
  }, [refresh]);

  const vaults = state.status === 'ready' ? state.data.vaults : [];
  const activeVaultId = state.status === 'ready' ? state.data.activeVaultId : '';
  const active = vaults.find((v) => v.vaultId === activeVaultId);
  const activeGatewayId = state.status === 'ready' ? state.data.activeGatewayId : undefined;
  const activeGatewayLabel = state.status === 'ready' ? state.data.activeGatewayLabel : undefined;
  const activeGatewayKind = state.status === 'ready' ? state.data.activeGatewayKind : undefined;

  const switchVault = useCallback((vaultId: string) => {
    void window.CentraidApi.setActiveVault({ vaultId });
  }, []);

  return {
    vaults,
    active,
    activeVaultId,
    activeGatewayId,
    activeGatewayLabel,
    activeGatewayKind,
    loading: state.status === 'loading',
    switchVault,
  };
}
