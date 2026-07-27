import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AssistOAuthHandoff from '../../../assist-oauth-handoff.js';
import type * as GatewayClient from '../../../gateway-client.js';
import type { ConnectionFormInput } from '../../screens/SettingsConnectionsScreen.js';
import {
  beginConnectionAuthorize,
  loadConnectionProvidersData,
  loadConnectionsData,
  loadConnectorToolDescriptors,
  makeDetachConnection,
  submitConnectionForm,
  updateConnectionStatus,
} from './settingsConnectionsData.js';

const listConnections = vi.fn<typeof GatewayClient.listConnections>();
const listConnectionProviders = vi.fn<typeof GatewayClient.listConnectionProviders>();
const listAutomations = vi.fn<typeof GatewayClient.listAutomations>(() => Promise.resolve([]));
const cloneTemplate = vi.fn<typeof GatewayClient.cloneTemplate>(() =>
  Promise.resolve({
    app: { id: 'github-pull' },
    template: {
      id: 'github-pull',
      name: 'GitHub pull',
      desc: '',
      colorKey: 'violet',
      iconKey: 'Sparkle',
      version: '0.1.0',
      kind: 'automation' as const,
    },
    webhooks: [],
  }),
);
const updateAutomation = vi.fn<typeof GatewayClient.updateAutomation>(() =>
  Promise.resolve({ row: null }),
);
const configureConnection = vi.fn<typeof GatewayClient.configureConnection>(() =>
  Promise.resolve({ connectionId: 'c1', credKind: 'oauth2', status: 'needs-auth' }),
);
const configureAssistConnection = vi.fn<typeof GatewayClient.configureAssistConnection>(() =>
  Promise.resolve({ connectionId: 'c-assist', credKind: 'oauth2', status: 'needs-auth' }),
);
const setConnectionStatus = vi.fn<typeof GatewayClient.setConnectionStatus>(() =>
  Promise.resolve({ connectionId: 'c1', status: 'paused' }),
);
const beginConnectionAuthorization = vi.fn<typeof GatewayClient.beginConnectionAuthorization>(() =>
  Promise.resolve({
    authUrl: 'https://accounts.example/auth',
    redirectUri: 'http://x',
    state: 's1',
  }),
);
const removeConnection = vi.fn<typeof GatewayClient.removeConnection>(() =>
  Promise.resolve({ connectionId: 'c1' }),
);

// `vi.mock` is hoisted above the imports by vitest, so the gateway stub lands
// before settingsConnectionsData.js pulls gateway-client-core's load-time
// side-effect (mirrors spaceModals.test.ts's approach).
vi.mock(import('../../../gateway-client.js'), () => ({
  beginConnectionAuthorization: (a) => beginConnectionAuthorization(a),
  cloneTemplate: (a) => cloneTemplate(a),
  configureAssistConnection: (a) => configureAssistConnection(a),
  configureConnection: (a) => configureConnection(a),
  listAutomations: () => listAutomations(),
  loadConnectionProviderCatalog: async () => ({
    assist: { enabled: false },
    providers: await listConnectionProviders(),
  }),
  listConnectionProviders: () => listConnectionProviders(),
  listConnections: () => listConnections(),
  oauthCallbackUri: () => Promise.resolve('http://127.0.0.1:17832/centraid/_vault/oauth/callback'),
  removeConnection: (a) => removeConnection(a),
  setConnectionStatus: (a) => setConnectionStatus(a),
  updateAutomation: (a) => updateAutomation(a),
}));
vi.mock(import('../../../assist-oauth-handoff.js'), () => ({
  completeAssistReturnLink: vi.fn<typeof AssistOAuthHandoff.completeAssistReturnLink>(),
}));

describe('settingsConnectionsData', () => {
  beforeEach(() => {
    window.CentraidApi = {
      getHostCapabilities: vi.fn<() => Promise<{ platform: 'desktop' }>>().mockResolvedValue({
        platform: 'desktop',
      }),
    } as unknown as typeof window.CentraidApi;
    listConnections.mockClear();
    listConnectionProviders.mockClear();
    configureConnection.mockClear();
    configureAssistConnection.mockClear();
    setConnectionStatus.mockClear();
    beginConnectionAuthorization.mockClear();
    removeConnection.mockClear();
  });

  describe('settingsConnectionsData', () => {
    it('loadConnectionsData maps the wire status onto the health enum', async () => {
      listConnections.mockResolvedValue([
        {
          allowedHosts: ['gmail.googleapis.com'],
          authNote: null,
          connectionId: 'c1',
          createdAt: '2026-01-01T00:00:00Z',
          credKind: 'oauth2',
          hasRefreshToken: true,
          kind: 'pull.gmail',
          label: 'Google · Gmail',
          lastRunAt: null,
          oauthMode: null,
          principal: 'me@example.com',
          provider: 'google',
          scopes: 'gmail.readonly',
          status: 'active',
          tokenExpiresAt: null,
          trust: 'staged',
        },
        {
          allowedHosts: null,
          authNote: 'authorization pending — run Connect',
          connectionId: 'c2',
          createdAt: '2026-01-01T00:00:00Z',
          credKind: 'oauth2',
          hasRefreshToken: false,
          kind: 'pull.gcal',
          label: 'Google · Calendar',
          lastRunAt: null,
          oauthMode: null,
          principal: null,
          provider: 'google',
          scopes: 'calendar.readonly',
          status: 'needs-auth',
          tokenExpiresAt: null,
          trust: 'staged',
        },
      ]);
      const rows = await loadConnectionsData();
      expect(rows).toHaveLength(2);
      // Attention sort: needs-auth before healthy.
      expect(rows[0]).toMatchObject({
        authNote: 'authorization pending — run Connect',
        connectionId: 'c2',
        health: 'needs-auth',
      });
      expect(rows[1]).toMatchObject({ connectionId: 'c1', health: 'ok', kind: 'pull.gmail' });
    });

    it('loadConnectionProvidersData passes the preset catalog through with capabilities', async () => {
      listConnectionProviders.mockResolvedValue([
        {
          allowedHosts: ['api.github.com'],
          connectors: [{ kind: 'pull.github', templateId: 'github-pull' }],
          credKind: 'api_key',
          id: 'github',
          name: 'GitHub (repos, issues, PRs)',
          setup: ['Open https://github.com/settings/personal-access-tokens'],
        },
      ]);
      const providers = await loadConnectionProvidersData();
      expect(providers).toHaveLength(1);
      expect(providers[0]).toMatchObject({
        allowedHosts: ['api.github.com'],
        connectors: [{ kind: 'pull.github', templateId: 'github-pull' }],
        credKind: 'api_key',
        id: 'github',
        name: 'GitHub (repos, issues, PRs)',
      });
      expect(providers[0]!.capabilities.syncs.some((s) => s.kind === 'pull.github')).toBe(true);
      expect(providers[0]!.capabilities.actions.some((a) => a.toolName.includes('github'))).toBe(
        true,
      );
    });

    it('loadConnectorToolDescriptors only exposes healthy connections and never secrets', async () => {
      listConnections.mockResolvedValue([
        {
          allowedHosts: ['api.github.com'],
          authNote: null,
          connectionId: 'ok1',
          createdAt: '2026-01-01T00:00:00Z',
          credKind: 'api_key',
          hasRefreshToken: false,
          kind: 'pull.github',
          label: 'GitHub',
          lastRunAt: null,
          oauthMode: null,
          principal: null,
          provider: 'github',
          scopes: null,
          status: 'active',
          tokenExpiresAt: null,
          trust: 'staged',
        },
        {
          allowedHosts: ['api.github.com'],
          authNote: 'expired',
          connectionId: 'bad1',
          createdAt: '2026-01-01T00:00:00Z',
          credKind: 'api_key',
          hasRefreshToken: false,
          kind: 'pull.github',
          label: 'GitHub dead',
          lastRunAt: null,
          oauthMode: null,
          principal: null,
          provider: 'github',
          scopes: null,
          status: 'needs-auth',
          tokenExpiresAt: null,
          trust: 'staged',
        },
      ]);
      listConnectionProviders.mockResolvedValue([
        {
          allowedHosts: ['api.github.com'],
          capabilities: {
            actions: [
              {
                id: 'action:list:pull.github',
                kind: 'pull.github',
                title: 'List',
                toolName: 'connector.pull_github.list',
              },
            ],
            syncs: [
              {
                defaultCron: '0 * * * *',
                id: 'sync:github-pull',
                kind: 'pull.github',
                templateId: 'github-pull',
                title: 'GitHub sync',
              },
            ],
          },
          connectors: [{ kind: 'pull.github', templateId: 'github-pull' }],
          credKind: 'api_key',
          id: 'github',
          name: 'GitHub',
          setup: [],
        },
      ]);
      const tools = await loadConnectorToolDescriptors();
      expect(tools.every((t) => t.connectionId === 'ok1')).toBe(true);
      expect(tools.some((t) => t.toolName === 'connector.pull_github.list')).toBe(true);
      const json = JSON.stringify(tools);
      expect(json).not.toMatch(/api_key|access_token|client_secret|refresh_token/);
    });

    it('submitConnectionForm builds the configure body from the form input', async () => {
      const input: ConnectionFormInput = {
        allowedHosts: ['api.github.com'],
        apiKey: 'ghp_xyz',
        connectorKind: 'pull.github',
        credKind: 'api_key',
        label: 'GitHub · Issues',
        providerId: 'github',
      };
      const out = await submitConnectionForm(input);
      expect(configureConnection).toHaveBeenCalledWith({
        allowedHosts: ['api.github.com'],
        apiKey: 'ghp_xyz',
        authUrl: undefined,
        clientId: undefined,
        clientSecret: undefined,
        credKind: 'api_key',
        kind: 'pull.github',
        label: 'GitHub · Issues',
        provider: 'github',
        scopes: undefined,
        tokenUrl: undefined,
      });
      expect(out).toStrictEqual({ connectionId: 'c1', status: 'needs-auth' });
    });

    it('updateConnectionStatus pauses/resumes by connection id', async () => {
      await updateConnectionStatus('c1', 'paused');
      expect(setConnectionStatus).toHaveBeenCalledWith({ connectionId: 'c1', status: 'paused' });
    });

    it('beginConnectionAuthorize returns just the auth URL', async () => {
      const url = await beginConnectionAuthorize('c1');
      expect(url).toBe('https://accounts.example/auth');
      expect(beginConnectionAuthorization).toHaveBeenCalledWith({
        connectionId: 'c1',
        surface: 'desktop',
      });
    });

    describe(makeDetachConnection, () => {
      it('does nothing when the owner declines the confirm', async () => {
        const confirm = vi.fn<Parameters<typeof makeDetachConnection>[0]>(() =>
          Promise.resolve(false),
        );
        const detach = makeDetachConnection(confirm);
        await detach('c1', 'pull.gmail', 'Google · Gmail');
        expect(confirm).toHaveBeenCalledWith({
          confirmLabel: 'Remove',
          danger: true,
          message:
            'Remove "Google · Gmail" completely? This deletes the connection and its credential — it can\'t be undone. If it still has undecided outbox items or sync history, removal will be refused; pause the connection instead if you just want it to stop.',
          title: 'Remove connection?',
        });
        expect(removeConnection).not.toHaveBeenCalled();
      });

      it('removes the connection entirely once confirmed', async () => {
        const confirm = vi.fn<Parameters<typeof makeDetachConnection>[0]>(() =>
          Promise.resolve(true),
        );
        const detach = makeDetachConnection(confirm);
        await detach('c1', 'pull.gmail', 'Google · Gmail');
        expect(removeConnection).toHaveBeenCalledWith('c1');
        expect(configureConnection).not.toHaveBeenCalled();
      });

      it('propagates a server refusal so the caller can toast the reason', async () => {
        removeConnection.mockRejectedValueOnce(
          new Error('has 1 outbox item(s) still awaiting a decision'),
        );
        const confirm = vi.fn<Parameters<typeof makeDetachConnection>[0]>(() =>
          Promise.resolve(true),
        );
        const detach = makeDetachConnection(confirm);
        await expect(detach('c1', 'pull.gmail', 'Google · Gmail')).rejects.toThrow(
          /awaiting a decision/,
        );
      });
    });
  });
});
