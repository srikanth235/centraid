import { describe, expect, it } from 'vitest';
import {
  automationLinksToConnection,
  buildAutomationConnectionsPayload,
  buildConnectorSpecPayload,
  connectionNeedsReconnect,
  sortConnectionsByAttention,
  toolDescriptorHasNoSecrets,
  toolDescriptorsFromHealthyConnections,
  type ConnectionHealthRow,
  type ProviderCapabilitiesDTO,
} from './connectorPlatform.js';

const capsGmail: ProviderCapabilitiesDTO = {
  syncs: [
    {
      id: 'sync:google-gmail-pull',
      title: 'Gmail sync',
      templateId: 'google-gmail-pull',
      kind: 'pull.gmail',
      defaultCron: '0 * * * *',
    },
  ],
  actions: [
    {
      id: 'action:list:pull.gmail',
      title: 'List recent Gmail',
      toolName: 'connector.pull_gmail.list',
      kind: 'pull.gmail',
    },
    {
      id: 'action:google-gmail-send',
      title: 'Gmail send',
      toolName: 'connector.pull_gmail.send',
      kind: 'pull.gmail',
      approval: 'outbox',
    },
  ],
};

function row(
  over: Partial<ConnectionHealthRow> & Pick<ConnectionHealthRow, 'connectionId'>,
): ConnectionHealthRow {
  return {
    kind: 'pull.gmail',
    label: 'Work Gmail',
    health: 'ok',
    provider: 'google',
    lastRunAt: null,
    authNote: null,
    credKind: 'oauth2',
    ...over,
  };
}

describe('connectorPlatform', () => {
  it('sorts unhealthy connections first (attention queue)', () => {
    const sorted = sortConnectionsByAttention([
      row({ connectionId: 'ok', health: 'ok' }),
      row({ connectionId: 'fail', health: 'failing' }),
      row({ connectionId: 'auth', health: 'needs-auth' }),
      row({ connectionId: 'pause', health: 'paused' }),
    ]);
    expect(sorted.map((r) => r.connectionId)).toEqual(['fail', 'auth', 'pause', 'ok']);
  });

  it('flags reconnect for needs-auth and failing only', () => {
    expect(connectionNeedsReconnect('needs-auth')).toBe(true);
    expect(connectionNeedsReconnect('failing')).toBe(true);
    expect(connectionNeedsReconnect('ok')).toBe(false);
    expect(connectionNeedsReconnect('paused')).toBe(false);
  });

  it('emits tool descriptors only for healthy connections', () => {
    const byProvider = new Map([['google', capsGmail]]);
    const tools = toolDescriptorsFromHealthyConnections({
      connections: [
        row({ connectionId: 'live', health: 'ok' }),
        row({ connectionId: 'dead', health: 'needs-auth' }),
        row({ connectionId: 'paused', health: 'paused' }),
      ],
      capabilitiesByProvider: byProvider,
    });
    expect(tools.every((t) => t.connectionId === 'live')).toBe(true);
    expect(tools.map((t) => t.toolName).sort()).toEqual([
      'connector.pull_gmail.list',
      'connector.pull_gmail.send',
    ]);
    expect(tools.every(toolDescriptorHasNoSecrets)).toBe(true);
  });

  it('does not advertise tools when provider capabilities are missing', () => {
    const tools = toolDescriptorsFromHealthyConnections({
      connections: [row({ connectionId: 'live', health: 'ok', provider: 'unknown' })],
      capabilitiesByProvider: new Map(),
    });
    expect(tools).toEqual([]);
  });

  it('builds durable connection binding payloads for automation save', () => {
    const payload = buildAutomationConnectionsPayload([
      { connectionId: 'c1', kind: 'pull.gmail', label: 'A' },
      { connectionId: 'c1', kind: 'pull.gmail', label: 'A' },
      { connectionId: 'c2', kind: 'pull.github', label: 'B' },
      { connectionId: '', kind: 'x', label: 'skip' },
    ]);
    expect(payload).toEqual([
      { connectionId: 'c1', kind: 'pull.gmail', label: 'A' },
      { connectionId: 'c2', kind: 'pull.github', label: 'B' },
    ]);
  });

  it('builds connector specs with optional connectionId', () => {
    expect(
      buildConnectorSpecPayload({
        kind: 'pull.github',
        label: 'personal',
        connectionId: 'conn-9',
      }),
    ).toEqual({
      kind: 'pull.github',
      label: 'personal',
      connectionId: 'conn-9',
    });
  });

  it('matches automations linked by connectionId or kind', () => {
    const conn = { connectionId: 'c1', kind: 'pull.gmail', label: 'Work' };
    expect(
      automationLinksToConnection(
        { manifest: { connector: { kind: 'pull.gmail', label: 'Work', connectionId: 'c1' } } },
        conn,
      ),
    ).toBe(true);
    expect(
      automationLinksToConnection(
        { manifest: { connections: [{ connectionId: 'c1', kind: 'pull.gmail' }] } },
        conn,
      ),
    ).toBe(true);
    expect(
      automationLinksToConnection(
        { manifest: { connector: { kind: 'pull.github', label: 'other' } } },
        conn,
      ),
    ).toBe(false);
  });
});
