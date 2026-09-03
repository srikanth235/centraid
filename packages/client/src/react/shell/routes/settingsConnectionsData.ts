import { completeAssistReturnLink as completeAssistReturnLinkFromClient } from "../../../assist-oauth-handoff.js";
import { describeCron, resolveCronTimezone } from "../../../cron.js";
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
} from "../../../gateway-client.js";
import type {
  ConnectionEntry,
  ConnectionProviderPreset,
  AssistOAuthAvailability,
} from "../../../gateway-client.js";
import type {
  AttachedSyncDTO,
  ConnectionFormInput,
  ConnectionHealth,
  ConnectionRowDTO,
  LinkedSyncDTO,
  ProviderOptionDTO,
} from "../../screens/SettingsConnectionsScreen.js";
import {
  sortConnectionsByAttention,
  toolDescriptorsFromHealthyConnections,
} from "./connectorPlatform.js";
import type { ProviderCapabilitiesDTO } from "./connectorPlatform.js";

const STATUS_TO_HEALTH: Record<ConnectionEntry["status"], ConnectionHealth> = {
  active: "ok",
  failing: "failing",
  "needs-auth": "needs-auth",
  paused: "paused",
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

function fallbackCapabilities(
  connectors: ConnectionProviderPreset["connectors"]
): ProviderOptionDTO["capabilities"] {
  const syncs: ProviderOptionDTO["capabilities"]["syncs"] = [];
  const actions: ProviderOptionDTO["capabilities"]["actions"] = [];
  for (const c of connectors) {
    if (c.templateId.endsWith("-send")) {
      actions.push({
        id: `action:${c.templateId}`,
        title: c.templateId,
        toolName: `connector.${c.kind.replace(/\./gu, "_")}.send`,
        kind: c.kind,
        templateId: c.templateId,
        approval: "outbox",
        ...(c.scope ? { scope: c.scope } : {}),
      });
      continue;
    }
    syncs.push({
      id: `sync:${c.templateId}`,
      title: `${c.templateId} sync`,
      templateId: c.templateId,
      kind: c.kind,
      defaultCron: "0 * * * *",
      ...(c.scope ? { scope: c.scope } : {}),
    });
    actions.push({
      id: `action:list:${c.kind}`,
      title: `List ${c.kind}`,
      toolName: `connector.${c.kind.replace(/\./gu, "_")}.list`,
      kind: c.kind,
      templateId: c.templateId,
      ...(c.scope ? { scope: c.scope } : {}),
    });
  }
  return { syncs, actions };
}

function toProviderDTO(
  p: ConnectionProviderPreset,
  assist: AssistOAuthAvailability
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
    ...(p.id === "google" ? { assist } : {}),
  };
}

export async function loadConnectionsData(): Promise<ConnectionRowDTO[]> {
  const rows = await listConnections();
  return sortConnectionsByAttention(rows.map(toRowDTO));
}

export async function loadConnectionProvidersData(): Promise<
  ProviderOptionDTO[]
> {
  const catalog = await loadConnectionProviderCatalog();
  return catalog.providers.map((provider) =>
    toProviderDTO(provider, catalog.assist)
  );
}

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

export async function loadLinkedSyncsForConnection(
  connection: ConnectionRowDTO
): Promise<LinkedSyncDTO[]> {
  const providers = await loadConnectionProvidersData();
  const provider =
    providers.find((p) => p.id === connection.provider) ??
    providers.find((p) => p.connectors.some((c) => c.kind === connection.kind));
  if (!provider) return [];
  const syncs = provider.capabilities.syncs.filter(
    (s) => s.kind === connection.kind
  );
  const automations = await listAutomations().catch(() => []);
  return syncs.map((s) => {
    const installed = automations.find((a) => {
      const m = a.manifest as {
        connector?: { kind?: string; connectionId?: string; label?: string };
      };
      const c = m.connector;
      if (!c) {
        return a.id === s.templateId || a.ref.endsWith(`/${s.templateId}`);
      }
      if (c.connectionId && c.connectionId === connection.connectionId)
        return true;
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

export async function loadAttachedSyncsData(
  connections: readonly ConnectionRowDTO[]
): Promise<AttachedSyncDTO[]> {
  const automations = await listAutomations().catch(() => []);
  const byId = new Map(connections.map((c) => [c.connectionId, c]));
  const byKind = new Map(connections.map((c) => [c.kind, c]));
  const out: AttachedSyncDTO[] = [];
  for (const row of automations) {
    const binding = (
      row.manifest as {
        connector?: { kind?: string; connectionId?: string; label?: string };
      }
    ).connector;
    if (!binding) continue;
    const connection =
      (binding.connectionId ? byId.get(binding.connectionId) : undefined) ??
      (binding.kind ? byKind.get(binding.kind) : undefined);
    if (!connection) continue;
    const cron = row.triggers.find(
      (t): t is { kind: "cron"; expr: string; tz?: string } => t.kind === "cron"
    );
    out.push({
      cadence: cron
        ? describeCron(cron.expr, resolveCronTimezone(cron.tz))
        : "On demand",
      connectionId: connection.connectionId,
      connectionLabel: connection.label,
      enabled: row.enabled,
      id: row.ref,
      name: row.name,
    });
  }
  return out;
}

export async function installSyncForConnection(input: {
  templateId: string;
  connection: ConnectionRowDTO;
}): Promise<{ ref: string }> {
  const result = await gwCloneTemplate({ templateId: input.templateId });
  const rows = await listAutomations().catch(() => []);
  const row = rows.find((r) => r.id === result.app.id);
  if (!row) {
    throw new Error(
      `cloned automation "${result.app.id}" was not available to bind`
    );
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

export async function submitConnectionForm(
  input: ConnectionFormInput
): Promise<{ connectionId: string; status: string }> {
  if (input.oauthMode === "assist") {
    const out = await gwConfigureAssistConnection({
      kind: input.connectorKind,
      label: input.label,
      scopes: input.scopes?.split(/\s+/u).filter(Boolean) ?? [],
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

export async function loadOAuthCallbackUri(): Promise<string> {
  return gwOauthCallbackUri();
}

export async function updateConnectionStatus(
  connectionId: string,
  status: "active" | "paused"
): Promise<void> {
  await gwSetConnectionStatus({ connectionId, status });
}

export async function beginConnectionAuthorize(
  connectionId: string
): Promise<string> {
  const capabilities = await window.CentraidApi.getHostCapabilities?.();
  const surface = capabilities?.platform === "web" ? "web" : "desktop";
  const { authUrl } = await beginConnectionAuthorization({
    connectionId,
    surface,
  });
  return authUrl;
}

export async function completeAssistReturnLink(
  rawUrl: string
): Promise<{ connectionId: string }> {
  return completeAssistReturnLinkFromClient(rawUrl);
}

export function makeDetachConnection(
  confirm: (opts: {
    title: string;
    message: string;
    confirmLabel?: string;
    danger?: boolean;
  }) => Promise<boolean>
): (connectionId: string, kind: string, label: string) => Promise<void> {
  return async (connectionId, _kind, label) => {
    const ok = await confirm({
      confirmLabel: "Remove",
      danger: true,
      message: `Remove "${label}" completely? This deletes the connection and its credential — it can't be undone. If it still has undecided outbox items or sync history, removal will be refused; pause the connection instead if you just want it to stop.`,
      title: "Remove connection?",
    });
    if (!ok) return;
    await gwRemoveConnection(connectionId);
  };
}
