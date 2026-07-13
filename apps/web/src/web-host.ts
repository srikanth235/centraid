import {
  decodeTicket,
  gatewayJson,
  loadConnection,
  loadSettingsPatch,
  publish,
  saveConnection,
  saveSettingsPatch,
  subscribe,
} from './web-state.js';
import type {
  CentraidConnectivityReport,
  CentraidGatewayRuntime,
  CentraidGatewayVaultEntry,
  CentraidSettings,
  CentraidTestConnectionInput,
} from '../../../packages/client/src/centraid-api.js';
import { pairGatewayOverIroh } from './iroh-transport.js';

const GATEWAY_EVENT = 'gateway-changed';
const VAULT_EVENT = 'vault-changed';
const METADATA_EVENT = 'vault-metadata';

function settings(): CentraidSettings {
  const connection = loadConnection();
  const patch = loadSettingsPatch() as Partial<CentraidSettings>;
  return {
    activeGatewayId: 'web',
    activeGatewayKind: 'remote',
    activeGatewayLabel: connection.label,
    activeProfileDisplayName: connection.displayName,
    activeProfileAvatarColor: connection.avatarColor,
    gatewayUrl: connection.baseUrl,
    ...(connection.token ? { gatewayToken: connection.token } : {}),
    ...(connection.vaultId ? { activeVaultId: connection.vaultId } : {}),
    ...patch,
  };
}

async function healthSnapshot(): Promise<CentraidGatewayRuntime> {
  const started = performance.now();
  try {
    const health = await gatewayJson<CentraidGatewayHealth>('/centraid/_gateway/health');
    const now = Date.now();
    return {
      gatewayId: 'web',
      gatewayLabel: loadConnection().label,
      gatewayKind: 'remote',
      trackingSince: now - health.uptimeMs,
      status: 'up',
      statusSince: now - health.uptimeMs,
      lastCheckAt: now,
      latencyMs: Math.round(performance.now() - started),
      gatewayStartedAt: Date.parse(health.startedAt),
      gatewayUptimeMs: health.uptimeMs,
      checksTotal: 1,
      checksFailed: 0,
      samples: [],
      outages: [],
      alert: { enabled: false, thresholdSeconds: 120 },
      pollIntervalMs: 5000,
      alertHistory: [],
      healthStatus: health.status,
      componentIssues: health.components
        .filter((component) => component.status !== 'ok')
        .map((component) => ({
          component: component.component,
          status: component.status,
          ...(component.lastError ? { message: component.lastError } : {}),
        })),
    };
  } catch (error) {
    return {
      gatewayId: 'web',
      gatewayLabel: loadConnection().label,
      gatewayKind: 'remote',
      trackingSince: Date.now(),
      status: 'down',
      lastCheckAt: Date.now(),
      lastError: error instanceof Error ? error.message : String(error),
      checksTotal: 1,
      checksFailed: 1,
      samples: [],
      outages: [],
      alert: { enabled: false, thresholdSeconds: 120 },
      pollIntervalMs: 5000,
      alertHistory: [],
    };
  }
}

async function testUrl(url: string, token?: string): Promise<CentraidConnectivityReport> {
  try {
    const response = await fetch(
      new URL('/centraid/_gateway/info', `${url.replace(/\/+$/, '')}/`),
      {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
    );
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        error: 'auth_failed',
        stages: [
          { id: 'reach', label: 'Reach gateway', status: 'pass' },
          {
            id: 'auth',
            label: 'Authenticate',
            status: 'fail',
            detail: 'The gateway rejected the credential.',
          },
        ],
      };
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return {
      ok: true,
      stages: [
        { id: 'reach', label: 'Reach gateway', status: 'pass' },
        { id: 'identify', label: 'Identify gateway', status: 'pass' },
        { id: 'auth', label: 'Authenticate', status: 'pass' },
      ],
    };
  } catch (error) {
    return {
      ok: false,
      error: 'unreachable',
      stages: [
        {
          id: 'reach',
          label: 'Reach gateway',
          status: 'fail',
          detail: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

export function installWebHost(): void {
  const api = {
    getHostCapabilities: async () => ({ platform: 'web' as const, appSessions: true }),
    getSettings: async () => settings(),
    saveSettings: async (patch: Partial<CentraidSettings>) => {
      saveSettingsPatch(patch as Record<string, unknown>);
      return settings();
    },
    getGatewayAuth: async () => {
      const connection = loadConnection();
      return {
        baseUrl: connection.baseUrl || window.location.origin,
        ...(connection.token ? { token: connection.token } : {}),
        ...(connection.vaultId ? { vaultId: connection.vaultId } : {}),
        ...(connection.control ? { webControl: true } : {}),
        ...(connection.transport === 'iroh' ? { iroh: true } : {}),
      };
    },
    listGateways: async () => {
      const connection = loadConnection();
      return connection.baseUrl || connection.transport === 'iroh'
        ? [
            {
              id: 'web',
              kind: 'remote' as const,
              label: connection.label,
              displayName: connection.displayName,
              avatarColor: connection.avatarColor,
              transport: connection.transport === 'iroh' ? ('iroh' as const) : ('direct' as const),
              ...(connection.transport === 'iroh'
                ? { endpointId: connection.endpointId }
                : { url: connection.baseUrl }),
              createdAt: new Date(0).toISOString(),
            },
          ]
        : [];
    },
    setActiveGateway: async () => settings(),
    addGateway: async (input: { label: string; url?: string; token: string }) => {
      const next = saveConnection({
        baseUrl: input.url ?? '',
        label: input.label,
        token: input.token,
        transport: 'direct',
        endpointTicket: undefined,
        endpointId: undefined,
        control: false,
      });
      publish(GATEWAY_EVENT, { activeGatewayId: 'web' });
      return {
        id: 'web',
        kind: 'remote' as const,
        label: next.label,
        displayName: next.displayName,
        avatarColor: next.avatarColor,
        transport: 'direct' as const,
        url: next.baseUrl,
        createdAt: new Date().toISOString(),
      };
    },
    removeGateway: async () => {
      // Server-side logout (issue #376): a control cookie is HttpOnly, so
      // clearing localStorage alone leaves the session valid on the gateway.
      // Fire a best-effort DELETE to drop it; never block or fail removal.
      const prev = loadConnection();
      if (prev.control && prev.baseUrl) {
        void fetch(new URL('/centraid/_web/control', `${prev.baseUrl.replace(/\/+$/, '')}/`), {
          method: 'DELETE',
          credentials: 'include',
        }).catch(() => undefined);
      }
      saveConnection({
        baseUrl: '',
        token: undefined,
        vaultId: undefined,
        transport: undefined,
        endpointTicket: undefined,
        endpointId: undefined,
        control: false,
      });
      publish(GATEWAY_EVENT, { activeGatewayId: 'web' });
      return { activeGatewayId: 'web' };
    },
    renameGateway: async ({ label }: { id: string; label: string }) => {
      saveConnection({ label });
      return (await api.listGateways())[0]!;
    },
    updateProfileMetadata: async (input: { displayName?: string; avatarColor?: string }) => {
      saveConnection(input);
      return (await api.listGateways())[0]!;
    },
    updateGatewayToken: async ({ token }: { id: string; token: string }) => {
      saveConnection({ token });
      return { ok: true as const };
    },
    redeemGatewayPairing: async (input: {
      ticket: string;
      label?: string;
      mode?: 'auto' | 'iroh' | 'http';
      url?: string;
    }) => {
      const decoded = decodeTicket(input.ticket);
      if (!decoded)
        return {
          ok: false as const,
          error: 'invalid_ticket' as const,
          message: 'Invalid pairing ticket.',
        };
      if (decoded.exp && decoded.exp <= Date.now()) {
        return {
          ok: false as const,
          error: 'ticket_expired' as const,
          message: 'This pairing ticket has expired.',
        };
      }
      const mode = input.mode === 'http' || (input.mode !== 'iroh' && input.url) ? 'http' : 'iroh';
      if (mode === 'http' && !input.url)
        return {
          ok: false as const,
          error: 'invalid_input' as const,
          message: 'Enter the gateway URL for direct browser pairing.',
        };
      try {
        if (mode === 'iroh') {
          if (!decoded.gw || !decoded.ticketId || !decoded.secret) {
            return {
              ok: false as const,
              error: 'invalid_ticket' as const,
              message: 'This ticket is missing Iroh pairing details.',
            };
          }
          const { response, endpointId } = await pairGatewayOverIroh({
            endpointTicket: decoded.gw,
            ticketId: decoded.ticketId,
            secret: decoded.secret,
            deviceName: input.label ?? 'Web browser',
          });
          if (!response.ok || !response.vaultId) {
            throw new Error(response.error ?? 'Gateway rejected the pairing ticket.');
          }
          saveConnection({
            baseUrl: '',
            token: undefined,
            control: false,
            transport: 'iroh',
            endpointTicket: decoded.gw,
            endpointId,
            vaultId: response.vaultId,
            label: input.label ?? response.gatewayName ?? 'Web gateway',
          });
          saveSettingsPatch({ onboardingCompletedAt: new Date().toISOString() });
          publish(GATEWAY_EVENT, { activeGatewayId: 'web' });
          publish(VAULT_EVENT, { activeGatewayId: 'web', activeVaultId: response.vaultId });
          return {
            ok: true as const,
            gatewayId: 'web',
            vaultId: response.vaultId,
            vaultName: response.vaultName ?? decoded.vaultName ?? 'Vault',
          };
        }
        const response = await fetch(
          new URL('/centraid/_gateway/pair', `${input.url!.replace(/\/+$/, '')}/`),
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              ticket: input.ticket,
              deviceLabel: input.label ?? 'Web browser',
              platform: 'web',
            }),
          },
        );
        const body = (await response.json()) as {
          ok?: boolean;
          deviceToken?: string;
          vaultId?: string;
          vaultName?: string;
        };
        if (!response.ok || !body.ok || !body.deviceToken || !body.vaultId)
          throw new Error(`Gateway returned HTTP ${response.status}`);
        const control = await fetch(
          new URL('/centraid/_web/control', `${input.url!.replace(/\/+$/, '')}/`),
          {
            method: 'POST',
            credentials: 'include',
            headers: { Authorization: `Bearer ${body.deviceToken}` },
          },
        );
        if (!control.ok)
          throw new Error(`Could not establish browser session (HTTP ${control.status})`);
        saveConnection({
          baseUrl: input.url!,
          token: undefined,
          control: true,
          transport: 'direct',
          endpointTicket: undefined,
          endpointId: undefined,
          vaultId: body.vaultId,
          label: input.label ?? 'Web gateway',
        });
        saveSettingsPatch({ onboardingCompletedAt: new Date().toISOString() });
        publish(GATEWAY_EVENT, { activeGatewayId: 'web' });
        publish(VAULT_EVENT, { activeGatewayId: 'web', activeVaultId: body.vaultId });
        return {
          ok: true as const,
          gatewayId: 'web',
          vaultId: body.vaultId,
          vaultName: body.vaultName ?? decoded.vaultName ?? 'Vault',
        };
      } catch (error) {
        return {
          ok: false as const,
          error: 'unreachable' as const,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
    testGatewayConnection: async (input: CentraidTestConnectionInput) => {
      if (input.kind === 'url') return testUrl(input.url, input.token);
      if (input.kind === 'ticket') {
        const decoded = decodeTicket(input.ticket);
        return decoded
          ? {
              ok: true,
              stages: [{ id: 'decode' as const, label: 'Decode ticket', status: 'pass' as const }],
              ticket: {
                vaultName: decoded.vaultName ?? 'Vault',
                expiresAt: new Date(decoded.exp ?? 0).toISOString(),
                gatewayEndpointId: decoded.gw ?? '',
              },
            }
          : {
              ok: false,
              error: 'invalid_ticket',
              stages: [
                {
                  id: 'decode' as const,
                  label: 'Decode ticket',
                  status: 'fail' as const,
                  detail: 'Invalid ticket.',
                },
              ],
            };
      }
      if (input.kind === 'gateway') {
        const connection = loadConnection();
        if (connection.transport === 'iroh') {
          try {
            await gatewayJson('/centraid/_gateway/info');
            return {
              ok: true,
              stages: [
                { id: 'reach' as const, label: 'Reach gateway over Iroh', status: 'pass' as const },
                { id: 'auth' as const, label: 'Authenticate device', status: 'pass' as const },
              ],
            };
          } catch (error) {
            return {
              ok: false,
              error: 'unreachable',
              stages: [
                {
                  id: 'reach' as const,
                  label: 'Reach gateway over Iroh',
                  status: 'fail' as const,
                  detail: error instanceof Error ? error.message : String(error),
                },
              ],
            };
          }
        }
        return testUrl(connection.baseUrl, connection.token);
      }
      return {
        ok: false,
        error: 'unsupported',
        stages: [
          {
            id: 'ssh' as const,
            label: 'Connect over SSH',
            status: 'fail' as const,
            detail: 'SSH setup is available in the desktop client.',
          },
        ],
      };
    },
    listGatewayVaults: async () => {
      try {
        const result = await gatewayJson<{ vaults: CentraidGatewayVaultEntry[] }>(
          '/centraid/_vault/vaults',
        );
        return {
          ok: true as const,
          vaults: result.vaults,
        };
      } catch {
        return { ok: false as const, error: 'unreachable' as const };
      }
    },
    setActiveVault: async ({ vaultId }: { vaultId?: string }) => {
      saveConnection({ vaultId });
      publish(VAULT_EVENT, { activeGatewayId: 'web', activeVaultId: vaultId });
      return settings();
    },
    getGatewayRuntime: healthSnapshot,
    onGatewayRuntime: (callback: (snapshot: CentraidGatewayRuntime) => void) => {
      const poll = async (): Promise<void> => callback(await healthSnapshot());
      const timer = window.setInterval(() => void poll(), 5000);
      return () => window.clearInterval(timer);
    },
    onGatewayChanged: (callback: (detail: unknown) => void) => subscribe(GATEWAY_EVENT, callback),
    onVaultChanged: (callback: (detail: unknown) => void) => subscribe(VAULT_EVENT, callback),
    onVaultMetadataChanged: (callback: () => void) => subscribe(METADATA_EVENT, callback),
    notifyVaultMetadataChanged: async () => publish(METADATA_EVENT, undefined),
    openAppFolder: async () => ({ ok: true as const }),
    getPublishStatus: async () => ({ inFlight: false }),
    onPublishEvent: () => () => {},
    getPhoneLinkStatus: async () => ({ running: false, devices: [] }),
    beginPhonePairing: async () => {
      throw new Error('Phone pairing is managed by the gateway or desktop client.');
    },
    cancelPhonePairing: async () => undefined,
    revokePhoneDevice: async () => ({ ok: true as const }),
    onPhonePaired: () => () => {},
    restartGateway: async () => ({ ok: false, error: 'Restart the gateway on its host.' }),
    exportGatewayDiagnostics: async () => ({
      ok: false as const,
      error: 'Use the gateway CLI to export diagnostics.',
    }),
    exportGatewayRecoveryKit: async () => ({
      ok: false as const,
      error: 'Use the gateway CLI to export the recovery kit.',
    }),
    createVault: async () => {
      throw new Error('Create vaults on the gateway host.');
    },
    deleteVault: async () => {
      throw new Error('Delete vaults on the gateway host.');
    },
    getUpdateStatus: async () => ({ available: false, version: 'web' }),
    onUpdateAvailable: () => () => {},
    relaunchToUpdate: async () => window.location.reload(),
    getChangelog: async () => ({ currentVersion: 'web', releases: [] }),
    sshConnectGateway: async () => ({
      ok: false as const,
      error: 'unsupported',
      message: 'SSH setup is available in the desktop client.',
    }),
  };

  window.CentraidApi = api as unknown as typeof window.CentraidApi;
}
