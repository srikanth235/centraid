import { useCallback, useEffect, useState } from "react";

import { listAppScopes, listVaults } from "../../gateway-client.js";
import type { OwnerScope } from "./ownerScope.js";
import { useAsyncData } from "./useAsyncData.js";

// Owner scope registry (#726). `GET /_vault/scopes` is the source; an older
// gateway degrades to `listVaults()` and those entries are treated writable.

export interface OwnerScopesController {
  scopes: OwnerScope[];
  primary: OwnerScope | undefined;
  active: OwnerScope | undefined;
  defaultScopeId: string;
  gatewayId: string | undefined;
  gatewayLabel: string | undefined;
  gatewayKind: "local" | "remote" | undefined;
  loading: boolean;
}

interface ScopesSnapshot {
  scopes: OwnerScope[];
  defaultScopeId: string;
  gatewayId: string | undefined;
  gatewayLabel: string | undefined;
  gatewayKind: "local" | "remote" | undefined;
}

async function loadScopes(): Promise<OwnerScope[]> {
  // Wrap the CALL: an unwired host throws synchronously, not as a rejection.
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
      canWrite: entry.canWrite,
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
    defaultScopeId: auth?.vaultId ?? scopes[0]?.id ?? "",
    gatewayId: settings?.activeGatewayId,
    gatewayLabel: settings?.activeGatewayLabel,
    gatewayKind: settings?.activeGatewayKind,
  };
}

export function useOwnerScopes(): OwnerScopesController {
  const [nonce, setNonce] = useState(0);
  const state = useAsyncData(loadScopeRegistry, [nonce]);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const api = window.CentraidApi as typeof window.CentraidApi | undefined;
    const offVault = api?.onVaultChanged?.(refresh);
    const offGateway = api?.onGatewayChanged?.(refresh);
    // Metadata-only: do not trip App.tsx `reScope` (onVaultChanged = pointer moved).
    const offMetadata = api?.onVaultMetadataChanged?.(refresh);
    return () => {
      offVault?.();
      offGateway?.();
      offMetadata?.();
    };
  }, [refresh]);

  const ready = state.status === "ready" ? state.data : undefined;
  const scopes = ready?.scopes ?? [];
  const defaultScopeId = ready?.defaultScopeId ?? "";
  const primary = scopes[0] ?? scopes.find((s) => s.id === defaultScopeId);
  const active = scopes.find((scope) => scope.id === defaultScopeId) ?? primary;

  return {
    scopes,
    primary,
    active,
    defaultScopeId,
    gatewayId: ready?.gatewayId,
    gatewayLabel: ready?.gatewayLabel,
    gatewayKind: ready?.gatewayKind,
    loading: state.status === "loading",
  };
}
