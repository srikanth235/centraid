import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionFormInput } from '../../screens/SettingsConnectionsScreen.js';
import {
  beginConnectionAuthorize,
  loadConnectionProvidersData,
  loadConnectionsData,
  makeDetachConnection,
  submitConnectionForm,
  updateConnectionStatus,
} from './settingsConnectionsData.js';

const listConnections = vi.fn();
const listConnectionProviders = vi.fn();
const configureConnection = vi.fn((_input?: unknown) =>
  Promise.resolve({ connectionId: 'c1', credKind: 'oauth2', status: 'needs-auth' }),
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
  configureConnection: (a: unknown) => configureConnection(a),
  listConnectionProviders: () => listConnectionProviders(),
  listConnections: () => listConnections(),
  removeConnection: (a: unknown) => removeConnection(a),
  setConnectionStatus: (a: unknown) => setConnectionStatus(a),
}));

beforeEach(() => {
  listConnections.mockClear();
  listConnectionProviders.mockClear();
  configureConnection.mockClear();
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
    expect(rows[0]).toMatchObject({ connectionId: 'c1', health: 'ok', kind: 'pull.gmail' });
    expect(rows[1]).toMatchObject({
      authNote: 'authorization pending — run Connect',
      connectionId: 'c2',
      health: 'needs-auth',
    });
  });

  it('loadConnectionProvidersData passes the preset catalog through', async () => {
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
    expect(providers).toEqual([
      {
        allowedHosts: ['api.github.com'],
        authUrl: undefined,
        connectors: [{ kind: 'pull.github', scope: undefined, templateId: 'github-pull' }],
        credKind: 'api_key',
        id: 'github',
        name: 'GitHub (repos, issues, PRs)',
        scopes: undefined,
        setup: ['Open https://github.com/settings/personal-access-tokens'],
        tokenUrl: undefined,
      },
    ]);
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
    await submitConnectionForm(input);
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
  });

  it('updateConnectionStatus pauses/resumes by connection id', async () => {
    await updateConnectionStatus('c1', 'paused');
    expect(setConnectionStatus).toHaveBeenCalledWith({ connectionId: 'c1', status: 'paused' });
  });

  it('beginConnectionAuthorize returns just the auth URL', async () => {
    const url = await beginConnectionAuthorize('c1');
    expect(url).toBe('https://accounts.example/auth');
    expect(beginConnectionAuthorization).toHaveBeenCalledWith({ connectionId: 'c1' });
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
