import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const listConnections = vi.fn();
const listConnectionProviders = vi.fn();
const listAutomations = vi.fn(() => Promise.resolve([]));
const cloneTemplate = vi.fn((_input?: unknown) =>
  Promise.resolve({ app: { id: 'github-pull' }, template: { id: 'github-pull' }, webhooks: [] }),
);
const updateAutomation = vi.fn((_input?: unknown) => Promise.resolve({ row: null }));
const configureConnection = vi.fn((_input?: unknown) =>
  Promise.resolve({ connectionId: 'c1', credKind: 'oauth2', status: 'needs-auth' }),
);
const configureAssistConnection = vi.fn((_input?: unknown) =>
  Promise.resolve({ connectionId: 'c-assist', credKind: 'oauth2', status: 'needs-auth' }),
);
const setConnectionStatus = vi.fn((_input?: unknown) =>
  Promise.resolve({ connectionId: 'c1', status: 'paused' }),
);
const beginConnectionAuthorization = vi.fn((_input?: unknown) =>
  Promise.resolve({
    authUrl: 'https://accounts.example/auth',
    redirectUri: 'http://x',
    state: 's1',
  }),
);
const removeConnection = vi.fn((_connectionId?: unknown) =>
  Promise.resolve({ connectionId: 'c1' }),
);

// `vi.mock` is hoisted above the imports by vitest, so the gateway stub lands
// before settingsConnectionsData.js pulls gateway-client-core's load-time
// side-effect (mirrors spaceModals.test.ts's approach).
vi.mock('../../../gateway-client.js', () => ({
  beginConnectionAuthorization: (a: unknown) => beginConnectionAuthorization(a),
  cloneTemplate: (a: unknown) => cloneTemplate(a),
  configureAssistConnection: (a: unknown) => configureAssistConnection(a),
  configureConnection: (a: unknown) => configureConnection(a),
  listAutomations: () => listAutomations(),
  loadConnectionProviderCatalog: async () => ({
    assist: { enabled: false },
    providers: await listConnectionProviders(),
  }),
  listConnectionProviders: () => listConnectionProviders(),
  listConnections: () => listConnections(),
  oauthCallbackUri: () => Promise.resolve('http://127.0.0.1:17832/centraid/_vault/oauth/callback'),
  removeConnection: (a: unknown) => removeConnection(a),
  setConnectionStatus: (a: unknown) => setConnectionStatus(a),
  updateAutomation: (a: unknown) => updateAutomation(a),
}));
vi.mock('../../../assist-oauth-handoff.js', () => ({
  completeAssistReturnLink: vi.fn(),
}));

beforeEach(() => {
  window.CentraidApi = {
    getHostCapabilities: vi.fn().mockResolvedValue({ platform: 'desktop' }),
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
    expect(out).toEqual({ connectionId: 'c1', status: 'needs-auth' });
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

  describe('makeDetachConnection', () => {
    it('does nothing when the owner declines the confirm', async () => {
      const confirm = vi.fn(() => Promise.resolve(false));
      const detach = makeDetachConnection(confirm);
      await detach('c1', 'pull.gmail', 'Google · Gmail');
      expect(confirm).toHaveBeenCalled();
      expect(removeConnection).not.toHaveBeenCalled();
    });

    it('removes the connection entirely once confirmed', async () => {
      const confirm = vi.fn(() => Promise.resolve(true));
      const detach = makeDetachConnection(confirm);
      await detach('c1', 'pull.gmail', 'Google · Gmail');
      expect(removeConnection).toHaveBeenCalledWith('c1');
      expect(configureConnection).not.toHaveBeenCalled();
    });

    it('propagates a server refusal so the caller can toast the reason', async () => {
      removeConnection.mockRejectedValueOnce(
        new Error('has 1 outbox item(s) still awaiting a decision'),
      );
      const confirm = vi.fn(() => Promise.resolve(true));
      const detach = makeDetachConnection(confirm);
      await expect(detach('c1', 'pull.gmail', 'Google · Gmail')).rejects.toThrow(
        /awaiting a decision/,
      );
    });
  });
});
