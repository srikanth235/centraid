import {
  beginConnectionAuthorization,
  cloneTemplate as gwCloneTemplate,
  configureAssistConnection as gwConfigureAssistConnection,
  configureConnection as gwConfigureConnection,
  listAutomations,
  loadConnectionProviderCatalog,
  listConnections,
  oauthCallbackUri as gwOauthCallbackUri,
  removeConnection as gwRemoveConnection,
  setConnectionStatus as gwSetConnectionStatus,
  updateAutomation,
  type ConnectionEntry,
  type ConnectionProviderPreset,
  type AssistOAuthAvailability,
} from '../../../gateway-client.js';
import type {
  ConnectionFormInput,
  ConnectionHealth,
  ConnectionRowDTO,
  LinkedSyncDTO,
  ProviderOptionDTO,
} from '../../screens/SettingsConnectionsScreen.js';
import {
  sortConnectionsByAttention,
  toolDescriptorsFromHealthyConnections,
  type ProviderCapabilitiesDTO,
} from './connectorPlatform.js';
import { completeAssistReturnLink as completeAssistReturnLinkFromClient } from '../../../assist-oauth-handoff.js';

// Connectors data layer (issue #304 renderer half; screen now lives on the
// primary Connectors sidebar route): maps the gateway's broker-owned OAuth /
// BYO-client connections surface (`gateway-client-connections.ts`) onto the
// screen's own DTOs, and hosts
// the one piece of policy that doesn't belong in a pure screen component —
// confirm-gating the destructive detach action, mirroring how SettingsRoute
// gates space deletion (`removeSpace`) with the same `confirm` action.

const STATUS_TO_HEALTH: Record<ConnectionEntry['status'], ConnectionHealth> = {
  active: 'ok',
  failing: 'failing',
  'needs-auth': 'needs-auth',
  paused: 'paused',
};

function toRowDTO(c: ConnectionEntry): ConnectionRowDTO {
  return {
    authNote: c.authNote,
    connectionId: c.connectionId,
    credKind: c.credKind,
    oauthMode: c.oauthMode,
    health: STATUS_TO_HEALTH[c.status],
    kind: c.kind,
    label: c.label,
    lastRunAt: c.lastRunAt,
    principal: c.principal,
    provider: c.provider,
  };
}

/** Derive capabilities when an older gateway omits the field. */
function fallbackCapabilities(
  connectors: ConnectionProviderPreset['connectors'],
): ProviderOptionDTO['capabilities'] {
  const syncs: ProviderOptionDTO['capabilities']['syncs'] = [];
  const actions: ProviderOptionDTO['capabilities']['actions'] = [];
  for (const c of connectors) {
    if (c.templateId.endsWith('-send')) {
      actions.push({
        id: `action:${c.templateId}`,
        title: c.templateId,
        toolName: `connector.${c.kind.replace(/\./g, '_')}.send`,
        kind: c.kind,
        templateId: c.templateId,
        approval: 'outbox',
        ...(c.scope ? { scope: c.scope } : {}),
      });
      continue;
    }
    syncs.push({
      id: `sync:${c.templateId}`,
      title: `${c.templateId} sync`,
      templateId: c.templateId,
      kind: c.kind,
      defaultCron: '0 * * * *',
      ...(c.scope ? { scope: c.scope } : {}),
    });
    actions.push({
      id: `action:list:${c.kind}`,
      title: `List ${c.kind}`,
      toolName: `connector.${c.kind.replace(/\./g, '_')}.list`,
      kind: c.kind,
      templateId: c.templateId,
      ...(c.scope ? { scope: c.scope } : {}),
    });
  }
  return { syncs, actions };
}

function toProviderDTO(
  p: ConnectionProviderPreset,
  assist: AssistOAuthAvailability,
): ProviderOptionDTO {
  const capabilities = p.capabilities
    ? {
        syncs: p.capabilities.syncs.map((s) => ({ ...s })),
        actions: p.capabilities.actions.map((a) => ({ ...a })),
      }
    : fallbackCapabilities(p.connectors);
  return {
    allowedHosts: p.allowedHosts,
    authUrl: p.authUrl,
    capabilities,
    connectors: p.connectors.map((c) => ({
      kind: c.kind,
      scope: c.scope,
      templateId: c.templateId,
    })),
    credKind: p.credKind,
    id: p.id,
    name: p.name,
    scopes: p.scopes,
    setup: p.setup,
    tokenUrl: p.tokenUrl,
    ...(p.id === 'google' ? { assist } : {}),
  };
}

export async function loadConnectionsData(): Promise<ConnectionRowDTO[]> {
  const rows = await listConnections();
  return sortConnectionsByAttention(rows.map(toRowDTO));
}

export async function loadConnectionProvidersData(): Promise<ProviderOptionDTO[]> {
  const catalog = await loadConnectionProviderCatalog();
  return catalog.providers.map((provider) => toProviderDTO(provider, catalog.assist));
}

/**
 * Tool descriptors for the assistant — only healthy connections; never
 * includes secret cells. Consumes the same list DTOs as the Connectors UI.
 */
export async function loadConnectorToolDescriptors(): Promise<
  ReturnType<typeof toolDescriptorsFromHealthyConnections>
> {
  const [rows, providers] = await Promise.all([
    loadConnectionsData(),
    loadConnectionProvidersData(),
  ]);
  const byProvider = new Map<string, ProviderCapabilitiesDTO>();
  for (const p of providers) {
    byProvider.set(p.id, p.capabilities);
  }
  return toolDescriptorsFromHealthyConnections({
    connections: rows,
    capabilitiesByProvider: byProvider,
  });
}

/** Sync capabilities for one connection with install status from vault automations. */
export async function loadLinkedSyncsForConnection(
  connection: ConnectionRowDTO,
): Promise<LinkedSyncDTO[]> {
  const providers = await loadConnectionProvidersData();
  const provider =
    providers.find((p) => p.id === connection.provider) ??
    providers.find((p) => p.connectors.some((c) => c.kind === connection.kind));
  if (!provider) return [];
  const syncs = provider.capabilities.syncs.filter((s) => s.kind === connection.kind);
  const automations = await listAutomations().catch(() => []);
  return syncs.map((s) => {
    const installed = automations.find((a) => {
      const m = a.manifest as {
        connector?: { kind?: string; connectionId?: string; label?: string };
      };
      const c = m.connector;
      if (!c) {
        // Template id often matches app id for pull blueprints.
        return a.id === s.templateId || a.ref.endsWith(`/${s.templateId}`);
      }
      if (c.connectionId && c.connectionId === connection.connectionId) return true;
      return c.kind === connection.kind;
    });
    return {
      capabilityId: s.id,
      title: s.title,
      templateId: s.templateId,
      kind: s.kind,
      installedRef: installed?.ref ?? null,
      installedEnabled: installed?.enabled ?? false,
    };
  });
}

/** Clone a pull blueprint and bind it to the vault connection id. */
export async function installSyncForConnection(input: {
  templateId: string;
  connection: ConnectionRowDTO;
}): Promise<{ ref: string }> {
  const result = await gwCloneTemplate({ templateId: input.templateId });
  const rows = await listAutomations().catch(() => []);
  const row = rows.find((r) => r.id === result.app.id);
  if (!row) {
    throw new Error(`cloned automation "${result.app.id}" was not available to bind`);
  }
  const ref = row?.ref ?? `${result.app.id}/${input.templateId}`;
  const existing = (
    row.manifest as {
      connector?: { kind?: string; label?: string; principal?: string };
    }
  ).connector;
  if (!existing?.kind || !existing.label) {
    throw new Error(`cloned automation "${ref}" has no connector binding`);
  }
  await updateAutomation({
    automationId: ref,
    connector: {
      kind: existing.kind,
      label: existing.label,
      connectionId: input.connection.connectionId,
      ...(existing.principal ? { principal: existing.principal } : {}),
    },
  });
  return { ref };
}

/** Attach a BYO credential for one connector kind — creates the `(kind,
 *  label)` connection row if it doesn't exist yet (issue #304's
 *  `sync.configure_credential`). Returns `connectionId` so oauth2 can
 *  immediately start the browser authorize step. */
export async function submitConnectionForm(
  input: ConnectionFormInput,
): Promise<{ connectionId: string; status: string }> {
  if (input.oauthMode === 'assist') {
    const out = await gwConfigureAssistConnection({
      kind: input.connectorKind,
      label: input.label,
      scopes: input.scopes?.split(/\s+/).filter(Boolean) ?? [],
    });
    return { connectionId: out.connectionId, status: out.status };
  }
  const out = await gwConfigureConnection({
    allowedHosts: input.allowedHosts,
    apiKey: input.apiKey,
    authUrl: input.authUrl,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    credKind: input.credKind,
    kind: input.connectorKind,
    label: input.label,
    provider: input.providerId,
    scopes: input.scopes,
    tokenUrl: input.tokenUrl,
  });
  return { connectionId: out.connectionId, status: out.status };
}

/**
 * The redirect URI the owner must paste into their Google / Microsoft /
 * Dropbox OAuth app. Same path the authorize ceremony uses.
 */
export async function loadOAuthCallbackUri(): Promise<string> {
  return gwOauthCallbackUri();
}

/** Pause / resume — the owner's two levers over a connection's fire path. */
export async function updateConnectionStatus(
  connectionId: string,
  status: 'active' | 'paused',
): Promise<void> {
  await gwSetConnectionStatus({ connectionId, status });
}

/** Begins the PKCE ceremony; the screen opens the returned URL itself. */
export async function beginConnectionAuthorize(connectionId: string): Promise<string> {
  const capabilities = await window.CentraidApi.getHostCapabilities?.();
  const surface = capabilities?.platform === 'web' ? 'web' : 'desktop';
  const { authUrl } = await beginConnectionAuthorization({ connectionId, surface });
  return authUrl;
}

/** Deliver the Worker finish page's manual custom-scheme fallback. */
export async function completeAssistReturnLink(rawUrl: string): Promise<{ connectionId: string }> {
  return completeAssistReturnLinkFromClient(rawUrl);
}

/**
 * Remove is a real, irreversible delete (issue #304's missing renderer
 * half — `sync.remove_connection`, distinct from the credential-only detach
 * `configure_credential({cred_kind:'none'})` performs): it rides the same
 * promise-based confirm dialog the Spaces page uses before deleting a space.
 * Still exported/named `makeDetachConnection` — `SettingsRoute.tsx` (owned
 * by another in-flight change in this tree) imports it under that name and
 * wires it to the screen's `detachConnection` prop; renaming either would
 * require touching that file, so the behavior changed here instead of the
 * name.
 *
 * The server may refuse (409: undecided outbox items, or receipted sync
 * history it won't shred) — that refusal is a real `GatewayClientError`
 * whose `message` IS the server's own reason, so it reaches the screen's
 * `showToast` unchanged instead of a generic "request failed".
 */
export function makeDetachConnection(
  confirm: (opts: {
    title: string;
    message: string;
    confirmLabel?: string;
    danger?: boolean;
  }) => Promise<boolean>,
): (connectionId: string, kind: string, label: string) => Promise<void> {
  return async (connectionId, _kind, label) => {
    const ok = await confirm({
      confirmLabel: 'Remove',
      danger: true,
      message: `Remove "${label}" completely? This deletes the connection and its credential — it can't be undone. If it still has undecided outbox items or sync history, removal will be refused; pause the connection instead if you just want it to stop.`,
      title: 'Remove connection?',
    });
    if (!ok) return;
    await gwRemoveConnection(connectionId);
  };
}
