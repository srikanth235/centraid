import { useCallback, useEffect, useState } from 'react';
import { listAppScopes, listVaults } from '../../gateway-client.js';
import { canWrite, type MemberScope } from './memberScope.js';
import { useAsyncData } from './useAsyncData.js';

// The member's scope registry (issue #599, Decision 14) — successor to the
// sidebar-head vault registry that fed the retired space switcher.
//
// A member holds a role in their own space and in every space the household
// added them to. `GET /_vault/scopes` answers that set for the CALLING MEMBER
// (roles come from the member layer, never from the device), so it is the right
// source for both the Household page and every "which space?" picker. An older
// gateway with no scopes plane degrades to `listVaults()`, whose entries carry
// no role — those are reported as `admin`, matching the single-owner world that
// gateway lives in.
//
// The DEFAULT scope pointer survives the switcher's retirement as an internal
// default: `useShellApps`' per-space home pins, the space/pairing flows, and the
// enrichment worker all still read it. What is gone is the MODE — nothing in the
// UI asks the member to "be in" a space any more; creation flows name their
// target and Household shows all of them at once.

export interface MemberScopesController {
  /** Every space this member holds a role in, own space first. */
  scopes: MemberScope[];
  /** The member's own (primary) space — the default target for anything new. */
  primary: MemberScope | undefined;
  /**
   * The shell's INTERNAL default-scope pointer. Not a mode: no UI switches it
   * any more, but the per-space home pins and the ambient request header still
   * resolve through it, so surfaces that have no explicit target read it here.
   */
  defaultScopeId: string;
  /** The gateway this client addresses. Undefined only while loading, or when
   *  `getSettings` is unavailable (stubbed test bridges). */
  gatewayId: string | undefined;
  gatewayLabel: string | undefined;
  gatewayKind: 'local' | 'remote' | undefined;
  /** True until the first fetch settles (success or failure). */
  loading: boolean;
}

interface ScopesSnapshot {
  scopes: MemberScope[];
  defaultScopeId: string;
  gatewayId: string | undefined;
  gatewayLabel: string | undefined;
  gatewayKind: 'local' | 'remote' | undefined;
}

async function loadScopes(): Promise<MemberScope[]> {
  // Both sources are wrapped rather than `.catch`-ed: a host (or a route test)
  // that never wired the vault client makes the CALL itself throw, not the
  // promise reject, and an unreachable registry must degrade to "no spaces
  // known" instead of taking the whole shell down with it.
  let fromPlane: Awaited<ReturnType<typeof listAppScopes>>;
  try {
    fromPlane = await listAppScopes();
  } catch {
    fromPlane = undefined;
  }
  if (fromPlane) {
    return fromPlane.map((entry) => ({
      id: entry.vaultId,
      label: entry.label,
      ...(entry.color ? { color: entry.color } : {}),
      ...(entry.icon ? { icon: entry.icon } : {}),
      role: entry.role,
      canWrite: canWrite(entry.role),
    }));
  }
  let legacy: Awaited<ReturnType<typeof listVaults>>;
  try {
    legacy = await listVaults();
  } catch {
    legacy = undefined;
  }
  return (legacy ?? []).map((entry) => ({
    id: entry.vaultId,
    label: entry.name,
    ...(entry.color ? { color: entry.color } : {}),
    ...(entry.icon ? { icon: entry.icon } : {}),
    role: 'admin',
    canWrite: true,
  }));
}

async function loadScopeRegistry(): Promise<ScopesSnapshot> {
  const api = window.CentraidApi as typeof window.CentraidApi | undefined;
  const [scopes, auth, settings] = await Promise.all([
    loadScopes(),
    api?.getGatewayAuth?.().catch(() => undefined),
    api?.getSettings?.().catch(() => undefined),
  ]);
  return {
    scopes,
    defaultScopeId: auth?.vaultId ?? scopes[0]?.id ?? '',
    gatewayId: settings?.activeGatewayId,
    gatewayLabel: settings?.activeGatewayLabel,
    gatewayKind: settings?.activeGatewayKind,
  };
}

export function useMemberScopes(): MemberScopesController {
  const [nonce, setNonce] = useState(0);
  const state = useAsyncData(loadScopeRegistry, [nonce]);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const api = window.CentraidApi as typeof window.CentraidApi | undefined;
    const offVault = api?.onVaultChanged?.(refresh);
    const offGateway = api?.onGatewayChanged?.(refresh);
    // Metadata-only changes (a space rename/retheme) are a separate broadcast
    // so a save there refreshes this registry WITHOUT tripping App.tsx's
    // `reScope` (which treats onVaultChanged as "the default pointer moved").
    const offMetadata = api?.onVaultMetadataChanged?.(refresh);
    return () => {
      offVault?.();
      offGateway?.();
      offMetadata?.();
    };
  }, [refresh]);

  const ready = state.status === 'ready' ? state.data : undefined;
  const scopes = ready?.scopes ?? [];
  const defaultScopeId = ready?.defaultScopeId ?? '';
  // The member's own space is the gateway's first, oldest scope; fall back to
  // whatever the default pointer names when the list is ordered otherwise.
  const primary = scopes[0] ?? scopes.find((s) => s.id === defaultScopeId);

  return {
    scopes,
    primary,
    defaultScopeId,
    gatewayId: ready?.gatewayId,
    gatewayLabel: ready?.gatewayLabel,
    gatewayKind: ready?.gatewayKind,
    loading: state.status === 'loading',
  };
}
