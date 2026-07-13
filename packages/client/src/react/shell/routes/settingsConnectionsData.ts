import {
  beginConnectionAuthorization,
  configureConnection as gwConfigureConnection,
  listConnectionProviders,
  listConnections,
  removeConnection as gwRemoveConnection,
  setConnectionStatus as gwSetConnectionStatus,
  type ConnectionEntry,
  type ConnectionProviderPreset,
} from '../../../gateway-client.js';
import type {
  ConnectionFormInput,
  ConnectionHealth,
  ConnectionRowDTO,
  ProviderOptionDTO,
} from '../../screens/SettingsConnectionsScreen.js';

// Settings → Connections data layer (issue #304's missing renderer half):
// maps the gateway's broker-owned OAuth / BYO-client connections surface
// (`gateway-client-connections.ts`) onto the screen's own DTOs, and hosts
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
    health: STATUS_TO_HEALTH[c.status],
    kind: c.kind,
    label: c.label,
    lastRunAt: c.lastRunAt,
    principal: c.principal,
    provider: c.provider,
  };
}

function toProviderDTO(p: ConnectionProviderPreset): ProviderOptionDTO {
  return {
    allowedHosts: p.allowedHosts,
    authUrl: p.authUrl,
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
  };
}

export async function loadConnectionsData(): Promise<ConnectionRowDTO[]> {
  const rows = await listConnections();
  return rows.map(toRowDTO);
}

export async function loadConnectionProvidersData(): Promise<ProviderOptionDTO[]> {
  const providers = await listConnectionProviders();
  return providers.map(toProviderDTO);
}

/** Attach a BYO credential for one connector kind — creates the `(kind,
 *  label)` connection row if it doesn't exist yet (issue #304's
 *  `sync.configure_credential`). */
export async function submitConnectionForm(input: ConnectionFormInput): Promise<void> {
  await gwConfigureConnection({
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
  const { authUrl } = await beginConnectionAuthorization({ connectionId });
  return authUrl;
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
