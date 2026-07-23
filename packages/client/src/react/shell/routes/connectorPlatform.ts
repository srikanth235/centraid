/**
 * Pure connectors-platform helpers — capability mapping, attention sort,
 * tool-descriptor gating, and automation connection binding payloads.
 * Kept free of React/gateway so unit tests assert the real shipped logic.
 */

export type ConnectionHealth = 'ok' | 'needs-auth' | 'paused' | 'failing';

export interface ConnectionHealthRow {
  connectionId: string;
  kind: string;
  label: string;
  health: ConnectionHealth;
  provider: string | null;
  lastRunAt: string | null;
  authNote: string | null;
  credKind: 'oauth2' | 'api_key' | null;
}

export interface ProviderSyncCap {
  id: string;
  title: string;
  templateId: string;
  kind: string;
  defaultCron: string;
  scope?: string;
}

export interface ProviderActionCap {
  id: string;
  title: string;
  toolName: string;
  kind: string;
  templateId?: string;
  approval?: 'outbox';
  scope?: string;
}

export interface ProviderCapabilitiesDTO {
  syncs: ProviderSyncCap[];
  actions: ProviderActionCap[];
}

/** Attention rank — lower sorts first (needs-auth / failing before healthy). */
export function connectionAttentionRank(health: ConnectionHealth): number {
  switch (health) {
    case 'failing':
      return 0;
    case 'needs-auth':
      return 1;
    case 'paused':
      return 2;
    case 'ok':
      return 3;
    default:
      return 4;
  }
}

/** Sort connections so unhealthy ones surface first (attention queue). */
export function sortConnectionsByAttention<T extends { health: ConnectionHealth }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort(
    (a, b) => connectionAttentionRank(a.health) - connectionAttentionRank(b.health),
  );
}

/** Whether the UI should show a primary Reconnect path (refresh credentials). */
export function connectionNeedsReconnect(health: ConnectionHealth): boolean {
  return health === 'needs-auth' || health === 'failing';
}

/**
 * One assistant tool descriptor — never includes secret cells. Only healthy
 * (`ok`) connections advertise tools.
 */
export interface ConnectorToolDescriptor {
  toolName: string;
  title: string;
  connectionId: string;
  kind: string;
  label: string;
  providerId: string | null;
  actionId: string;
  approval?: 'outbox';
}

export function toolDescriptorsFromHealthyConnections(input: {
  connections: readonly ConnectionHealthRow[];
  /** providerId → capabilities */
  capabilitiesByProvider: ReadonlyMap<string, ProviderCapabilitiesDTO>;
  /** kind → capabilities when provider is missing (fallback via connector kind). */
  capabilitiesByKind?: ReadonlyMap<string, ProviderCapabilitiesDTO>;
}): ConnectorToolDescriptor[] {
  const out: ConnectorToolDescriptor[] = [];
  for (const row of input.connections) {
    if (row.health !== 'ok') continue;
    const caps =
      (row.provider ? input.capabilitiesByProvider.get(row.provider) : undefined) ??
      input.capabilitiesByKind?.get(row.kind);
    if (!caps) continue;
    for (const action of caps.actions) {
      if (action.kind !== row.kind) continue;
      out.push({
        toolName: action.toolName,
        title: action.title,
        connectionId: row.connectionId,
        kind: row.kind,
        label: row.label,
        providerId: row.provider,
        actionId: action.id,
        ...(action.approval ? { approval: action.approval } : {}),
      });
    }
  }
  return out;
}

/** Secret-bearing keys that must never appear on list/tool DTOs. */
const FORBIDDEN_SECRET_KEYS = [
  'clientSecret',
  'client_secret',
  'apiKey',
  'api_key',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'token',
  'secret',
] as const;

/** Structural check: tool descriptors expose no secret cells. */
export function toolDescriptorHasNoSecrets(d: ConnectorToolDescriptor): boolean {
  const json = JSON.stringify(d);
  for (const k of FORBIDDEN_SECRET_KEYS) {
    if (json.includes(`"${k}"`)) return false;
  }
  return true;
}

/**
 * Wire shape for automation create/update when the editor binds selected
 * catalog connections. Soft bindings only (agent automations) — not a
 * published `connector` block (which forbids ctx.agent).
 */
export interface AutomationConnectionBindingPayload {
  connectionId: string;
  kind: string;
  label: string;
}

export function buildAutomationConnectionsPayload(
  selected: readonly {
    connectionId: string;
    kind: string;
    label: string;
  }[],
): AutomationConnectionBindingPayload[] {
  const seen = new Set<string>();
  const out: AutomationConnectionBindingPayload[] = [];
  for (const s of selected) {
    if (!s.connectionId || seen.has(s.connectionId)) continue;
    seen.add(s.connectionId);
    out.push({
      connectionId: s.connectionId,
      kind: s.kind,
      label: s.label,
    });
  }
  return out;
}

/**
 * Published-connector binding (kind + label + durable connectionId) for
 * pull automations that already declare `manifest.connector`.
 */
export function buildConnectorSpecPayload(input: {
  kind: string;
  label: string;
  connectionId?: string;
  principal?: string;
}): { kind: string; label: string; connectionId?: string; principal?: string } {
  return {
    kind: input.kind,
    label: input.label,
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    ...(input.principal ? { principal: input.principal } : {}),
  };
}

/** Match automations whose connector kind or connections[] include this kind. */
export function automationLinksToConnection(
  automation: {
    manifest?: {
      connector?: { kind?: string; label?: string; connectionId?: string };
      connections?: readonly { connectionId?: string; kind?: string }[];
    };
  },
  connection: { connectionId: string; kind: string; label: string },
): boolean {
  const c = automation.manifest?.connector;
  if (c) {
    if (c.connectionId && c.connectionId === connection.connectionId) return true;
    if (c.kind === connection.kind && c.label === connection.label) return true;
    if (c.kind === connection.kind && !c.connectionId) return true;
  }
  const bindings = automation.manifest?.connections ?? [];
  return bindings.some(
    (b) =>
      b.connectionId === connection.connectionId || (b.kind === connection.kind && !b.connectionId),
  );
}
