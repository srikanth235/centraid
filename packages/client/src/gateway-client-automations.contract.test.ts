import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const getGatewayAuth = vi.fn();
const fetchMock = vi.fn();
let hostAppSessions = false;
let forceVault404 = false;

let client: typeof import('./gateway-client.js');
let vault: typeof import('./gateway-client-vault.js');
let editing: typeof import('./gateway-client-automation-editing.js');
let outbox: typeof import('./gateway-client-outbox.js');
let logs: typeof import('./gateway-client-logs.js');
let compile: typeof import('./gateway-client-automation-compile.js');
let resetGatewayAuthCache: typeof import('./gateway-client-core.js').resetGatewayAuthCache;
let resetAppSessions: typeof import('./gateway-client-editing.js').resetAppSessions;

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function stream(frames: string, headers?: HeadersInit): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frames));
        controller.close();
      },
    }),
    { status: 200, headers },
  );
}

function row(): CentraidAutomationRow {
  const triggers: CentraidAutomationManifest['triggers'] = [{ kind: 'cron', expr: '0 9 * * *' }];
  return {
    id: 'daily',
    dir: '/apps/daily',
    name: 'Daily',
    triggers,
    enabled: true,
    ownerApp: 'daily',
    ref: 'daily/daily',
    manifest: {
      name: 'Daily',
      version: '0.1.0',
      enabled: true,
      prompt: 'Run daily.',
      triggers,
      requires: {},
      history: { keep: { count: 10 } },
      generated: { by: 'agent', at: '2026-07-25T00:00:00.000Z' },
    },
  };
}

function responseFor(rawUrl: string, init?: RequestInit): Response {
  const url = new URL(rawUrl);
  const path = `${url.pathname}${url.search}`;
  const method = init?.method ?? 'GET';

  if (path === '/centraid/_gateway/info')
    return json({
      capabilities: {
        webSessions: true,
        devicePairing: true,
        tunnel: true,
        backupWal: true,
        assistOAuth: true,
        automationTurns: true,
      },
    });
  if (path.includes('/web-session')) return json({ launchPath: '/centraid/_web/session/launch-1' });
  if (path.includes('/git-versions'))
    return json({
      versions: [
        {
          tag: 'v2',
          version: 2,
          sha: 'abc',
          uploadedAt: '2026-07-25T00:00:00.000Z',
          active: true,
        },
      ],
    });
  if (path.endsWith('/rollback')) return json({ id: 'daily', sha: 'abc' });
  if (path.endsWith('/logs') || path.includes('/logs?'))
    return json({
      entries: [{ ts: 1, level: 'info', source: 'query', handler: 'list', msg: 'ok' }],
    });
  if (path.endsWith('/settings')) return json({ settings: { timezone: 'UTC' } });
  if (path === '/centraid/_apps' && method === 'GET')
    return json([{ id: 'daily', hasIndex: true }]);
  if (path === '/centraid/_templates') return json([]);
  if (path === '/_centraid-user/id') return json({ id: 'user-1' });
  if (path === '/_centraid-user/prefs') return json({ prefs: { runner: 'codex' } });
  if (path === '/centraid/_apps/_sessions' && method === 'POST') {
    const body = JSON.parse(String(init?.body)) as { sessionId: string };
    return json({ sessionId: body.sessionId });
  }
  if (path === '/centraid/_automations' && method === 'GET') return json({ rows: [row()] });
  if (path === '/centraid/_automations' && method === 'POST')
    return json({
      row: row(),
      webhook: { id: 'hook-1', secret: 'secret-1', url: 'https://gateway.test/hook-1' },
    });
  if (path.startsWith('/centraid/_automations/read')) return json({ row: row() });
  if (path.startsWith('/centraid/_automations/update'))
    return json({
      row: row(),
      webhook: { id: 'hook-1', secret: 'secret-2', url: 'https://gateway.test/hook-1' },
    });
  if (path.startsWith('/centraid/_automations/rotate-webhook'))
    return json({
      webhook: { id: 'hook-1', secret: 'secret-3', url: 'https://gateway.test/hook-1' },
    });
  if (path.startsWith('/centraid/_automations/turn-now')) return json({ turnId: 'turn-1' });
  if (path.startsWith('/centraid/_automations/turns'))
    return json({ turns: [{ turnId: 'turn-1', startedAt: 1, endedAt: 2, ok: true }] });
  if (path.startsWith('/centraid/_automations/turn/items'))
    return json({ items: [{ itemId: 'item-1', kind: 'assistant', ordinal: 0 }] });
  if (path.startsWith('/centraid/_automations/turn/events'))
    return stream(
      'data: not-json\n\ndata: {"missing":"type"}\n\ndata: {"type":"turn.end","turnId":"turn-1","ok":true}\n\n',
    );
  if (path.startsWith('/centraid/_automations/turn?') && method === 'POST')
    return stream(
      'event: final\ndata: {"type":"final","text":"done"}\n\nevent: end\ndata: {}\n\n',
      { 'x-centraid-turn-id': 'turn-2' },
    );
  if (path.startsWith('/centraid/_automations/turn?'))
    return json({
      turn: { turnId: 'turn-1', startedAt: 1, endedAt: 2, ok: true },
      items: [{ itemId: 'item-1', kind: 'assistant', ordinal: 0 }],
    });
  if (path.startsWith('/centraid/_automations/source'))
    return json({ manifest: '{"name":"Daily"}', handler: 'export default {}' });
  if (path.startsWith('/centraid/_automations/compile'))
    return json({ compileTurnId: 'compile-1' });
  if (path.startsWith('/centraid/_automations/revise')) return json({ compileTurnId: 'compile-2' });
  if (path.startsWith('/centraid/_automations/turn/pin')) return json({ ok: true });
  if (path.startsWith('/centraid/_automations/set-enabled')) return json({ ok: true });
  if (path.startsWith('/centraid/_automations?') && method === 'DELETE')
    return json({ deletedApp: true });
  if (path.startsWith('/centraid/_insights/summary')) return json({ totals: {} });
  if (path === '/centraid/_gateway/health') return json({ status: 'ok', components: [] });
  if (path === '/centraid/_gateway/resource/pause')
    return method === 'DELETE'
      ? json({ paused: false })
      : json({ paused: true, until: '2026-07-25T01:00:00.000Z' });

  if (path === '/centraid/_vault/status')
    return forceVault404
      ? new Response(null, { status: 404 })
      : json({ vaultId: 'vault-1', name: 'Home', ownerPartyId: 'party-1', fresh: false });
  if (path === '/centraid/_vault/vaults')
    return forceVault404
      ? new Response(null, { status: 404 })
      : json({ vaults: [{ vaultId: 'vault-1', name: 'Home', ownerPartyId: 'party-1' }] });
  if (path.startsWith('/centraid/_vault/vaults/'))
    return json({ vaultId: 'vault-1', name: 'Renamed', ownerPartyId: 'party-1' });
  if (path === '/centraid/_vault/agents') return json({ agents: [] });
  if (path === '/centraid/_vault/entities') return json({ entities: ['business.invoice'] });
  if (path.startsWith('/centraid/_vault/picker')) return json({ cards: [] });
  if (path.startsWith('/centraid/_vault/anchors')) return json({ anchors: [] });
  if (path === '/centraid/_vault/apps') return json({ apps: [] });
  if (path.includes('/grants') && method === 'POST') return json({ grantId: 'grant-1' });
  if (path.startsWith('/centraid/_vault/grants/'))
    return json({ viewsRevoked: 1, parkedDropped: 1 });
  if (path === '/centraid/_vault/parked') return json({ parked: [] });
  if (path.startsWith('/centraid/_vault/parked/')) return json({ status: 'executed' });
  if (path === '/centraid/_vault/demo') return json({ apps: [] });
  if (path.startsWith('/centraid/_vault/demo/')) return json({ rows: 3 });
  if (path === '/centraid/_vault/imports' && method === 'POST')
    return json({
      batchId: 'batch-1',
      kind: 'csv',
      staged: { invoice: 1 },
      total: 1,
      unrouted: [],
    });
  if (path === '/centraid/_vault/imports' && method === 'GET') return json({ batches: [] });
  if (path.endsWith('/publish')) return json({ created: 1, updated: 0, skipped: 0, failed: [] });
  if (path.endsWith('/discard')) return json({ receiptId: 'receipt-1' });
  if (path === '/centraid/_vault/imports/connections') return json({ connections: [] });
  if (path.includes('/imports/connections/')) return json({ ok: true });
  if (path.startsWith('/centraid/_vault/imports/')) return json({ rows: [] });

  if (path === '/centraid/_vault/blocking')
    return json({ outbox: [], needsAuth: [], parked: [], scopeRequests: [] });
  if (path.startsWith('/centraid/_vault/review')) return json({ entries: [] });
  if (path.startsWith('/centraid/_vault/outbox?') || path === '/centraid/_vault/outbox')
    return json({ items: [] });
  if (path.startsWith('/centraid/_vault/outbox/'))
    return json({ status: 'executed', item_id: 'item-1' }, 409);
  if (path === '/centraid/_vault/outbox-grants') return json({ grants: [] });
  if (path.startsWith('/centraid/_vault/outbox-grants/'))
    return json({ status: 'revoked', grant_id: 'grant-1' }, 409);
  if (path === '/centraid/_vault/scope-requests') return json({ requests: [] });
  if (path.startsWith('/centraid/_vault/scope-requests/'))
    return json({ request: { requestId: 'scope-1' }, approved: true });

  if (path.startsWith('/centraid/_logs/events'))
    return stream(
      'data: nope\n\ndata: {"seq":"bad","message":"skip"}\n\ndata: {"seq":2,"ts":1,"level":"info","message":"ready"}\n\n',
    );
  if (path.startsWith('/centraid/_logs'))
    return json({ entries: [{ seq: 1, ts: 1, level: 'info', message: 'booted' }] });
  if (path.startsWith('/centraid/_apps/') && method === 'DELETE') return json({ id: 'daily' });

  return json({ ok: true });
}

beforeAll(async () => {
  window.CentraidApi = {
    getGatewayAuth,
    getHostCapabilities: async () => ({ appSessions: hostAppSessions }),
    onGatewayChanged: () => () => undefined,
    onVaultChanged: () => () => undefined,
  } as unknown as typeof window.CentraidApi;
  vi.stubGlobal('fetch', fetchMock);
  client = await import('./gateway-client.js');
  vault = await import('./gateway-client-vault.js');
  editing = await import('./gateway-client-automation-editing.js');
  outbox = await import('./gateway-client-outbox.js');
  logs = await import('./gateway-client-logs.js');
  compile = await import('./gateway-client-automation-compile.js');
  ({ resetGatewayAuthCache } = await import('./gateway-client-core.js'));
  ({ resetAppSessions } = await import('./gateway-client-editing.js'));
});

beforeEach(() => {
  hostAppSessions = false;
  forceVault404 = false;
  getGatewayAuth.mockReset().mockResolvedValue({
    baseUrl: 'https://gateway.test',
    gatewayId: 'gateway-1',
    token: 'token-1',
    vaultId: 'vault-1',
  });
  fetchMock.mockReset().mockImplementation(responseFor);
  resetGatewayAuthCache();
  resetAppSessions();
});

describe('renderer gateway automation contracts', () => {
  it('covers the app, turn, health, compile, and lifecycle surfaces', async () => {
    await expect(client.readGatewayCapabilities()).resolves.toMatchObject({
      automationTurns: true,
    });
    await expect(client.appLiveUrl({ id: 'daily' })).resolves.toEqual({
      url: 'https://gateway.test/centraid/daily/',
    });
    hostAppSessions = true;
    await expect(client.appLiveUrl({ id: 'daily' })).resolves.toEqual({
      url: 'https://gateway.test/centraid/_web/session/launch-1',
    });

    await client.appLogs({ id: 'daily', limit: 7, sinceTs: 1, level: 'info' });
    await client.appSettings({ id: 'daily' });
    await client.appSettingWrite({ id: 'daily', key: 'timezone', value: undefined });
    await client.deregisterApp({ id: 'old app' });
    await client.listApps();
    await client.listTemplates();
    await expect(client.listVersions({ id: 'daily' })).resolves.toMatchObject({
      activeVersion: 'v2',
      versions: [expect.objectContaining({ current: true, versionId: 'v2' })],
    });
    await client.activateVersion({ id: 'daily', versionId: 'v2' });
    await client.getUserId();
    await client.getUserPrefs();
    await client.saveUserPrefs({ runner: 'codex' });
    await client.listAutomations();
    await expect(client.readAutomation({ automationId: 'invalid' })).resolves.toBeNull();
    await client.readAutomation({ automationId: 'daily/daily' });
    await client.runAutomationNow({ automationId: 'daily/daily' });
    await client.listAutomationTurns({ automationId: 'daily/daily', limit: 3 });
    await client.listAutomationTurns({});
    await client.readAutomationTurn({ turnId: 'turn-1' });
    await client.readAutomationTurnExpanded({ turnId: 'turn-1' });
    await client.readLatestAutomationTurnExpanded({ automationId: 'daily/daily' });
    await client.listAutomationItems({ turnId: 'turn-1' });

    const turnEvents: string[] = [];
    await client.streamAutomationTurn(
      'turn-1',
      (event) => turnEvents.push(event.type),
      new AbortController().signal,
    );
    expect(turnEvents).toEqual(['turn.end']);
    const conversationEvents: string[] = [];
    await expect(
      client.streamAutomationConversationTurn(
        'daily/daily',
        'revise it',
        (event) => conversationEvents.push(event.type),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ ended: true, turnId: 'turn-2' });
    expect(conversationEvents).toContain('final');

    await client.pinAutomationTurn({ turnId: 'turn-1', pinned: true });
    await client.getInsightsSummary({ windowDays: 7 });
    await client.getInsightsSummary();
    await client.getGatewayHealth();
    await client.pauseBackgroundWork(60_000);
    await client.pauseBackgroundWork();
    await client.resumeBackgroundWork();
    await compile.compileAutomation({ automationId: 'daily/daily', enableOnSuccess: true });
    await compile.reviseAutomation({ automationId: 'daily/daily', message: 'be concise' });
    await compile.readAutomationSource('daily/daily');

    const created = await editing.createAutomation({
      id: 'daily',
      name: 'Daily',
      prompt: 'Run daily',
      triggers: [{ kind: 'cron', expr: '0 9 * * *' }],
      runner: 'codex',
      model: 'openai/gpt-test',
    });
    expect(created.webhook?.secret).toBe('secret-1');
    const updated = await editing.updateAutomation({
      automationId: 'daily/daily',
      name: 'Daily revised',
      prompt: 'Run every day',
      triggers: [{ kind: 'webhook' }],
      connections: [{ connectionId: 'connection-1', kind: 'github', label: 'Work' }],
      connector: { kind: 'github', label: 'Work', connectionId: 'connection-1' },
      runner: null,
      model: null,
    });
    expect(updated.webhook?.secret).toBe('secret-2');
    await editing.setAutomationEnabled({ automationId: 'daily/daily', enabled: false });
    await editing.rotateAutomationWebhookSecret({ automationId: 'daily/daily' });
    await editing.deleteAutomation({ automationId: 'daily/daily' });

    const paths = fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname);
    expect(paths).toContain('/centraid/_automations/compile');
    expect(paths).toContain('/centraid/_automations/revise');
    expect(paths).toContain('/centraid/_automations/set-enabled');
    expect(paths).toContain('/centraid/_apps/_sessions/desktop-daily');
  });

  it('covers owner vault, import, outbox, and log transport contracts', async () => {
    await vault.listAgents();
    await vault.listVaultEntityTypes();
    await vault.searchVaultEntities('invoice');
    await vault.searchVaultAnchors('amount');
    await vault.vaultStatus();
    await vault.listVaults();
    await vault.updateVault({
      vaultId: 'vault-1',
      name: 'Renamed',
      color: null,
      icon: 'home',
      blurb: undefined,
    });
    await vault.vaultApps();
    await vault.approveVaultGrant({
      appId: 'daily',
      purpose: 'dpv:ServiceProvision',
      scopes: [{ schema: 'business', table: 'invoice', verbs: 'read' }],
      expiresAt: '2026-08-01T00:00:00.000Z',
    });
    await vault.revokeVaultGrant({ grantId: 'grant-1' });
    await vault.vaultParked();
    await vault.confirmVaultParked({ invocationId: 'invocation-1', approve: true });
    await vault.vaultDemoStatus();
    await vault.vaultDemoLoad('daily');
    await vault.vaultImportStage({
      filename: 'invoices.csv',
      text: 'id,total\n1,5',
      accountName: 'Work',
      currency: 'USD',
    });
    await vault.vaultImportsList();
    await vault.vaultImportRows('batch-1');
    await vault.vaultImportPublish('batch-1');
    await vault.vaultImportDiscard('batch-1');
    await vault.vaultConnections();
    await vault.vaultConnectionSetStatus('connection-1', 'paused');

    await outbox.getBlocking();
    await outbox.getReview(5);
    await outbox.getReview();
    await outbox.listOutboxItems(['pending', 'parked']);
    await outbox.listOutboxItems();
    await expect(
      outbox.decideOutboxItem({
        itemId: 'item-1',
        decision: 'approve',
        artifact: { subject: 'Hello' },
        alwaysAllow: true,
        note: 'Reviewed',
      }),
    ).resolves.toMatchObject({ status: 'executed' });
    await outbox.listOutboxGrants();
    await outbox.revokeOutboxGrant('grant-1');
    await outbox.listScopeRequests();
    await outbox.decideScopeRequest({ requestId: 'scope-1', approve: true });

    await expect(logs.fetchGatewayLogs({ after: 1, limit: 10 })).resolves.toMatchObject({
      entries: [expect.objectContaining({ message: 'booted' })],
    });
    const entries: string[] = [];
    await logs.streamGatewayLogs(
      (entry) => entries.push(entry.message),
      new AbortController().signal,
      1,
    );
    expect(entries).toEqual(['ready']);

    const writes = fetchMock.mock.calls.map(([url, init]) => ({
      method: (init as RequestInit | undefined)?.method,
      path: new URL(String(url)).pathname,
    }));
    expect(writes).toContainEqual({
      method: 'POST',
      path: '/centraid/_vault/imports/batch-1/publish',
    });
    expect(writes).toContainEqual({
      method: 'POST',
      path: '/centraid/_vault/outbox/item-1',
    });
  });

  it('treats an absent vault plane as a valid state', async () => {
    forceVault404 = true;
    await expect(vault.vaultStatus()).resolves.toBeUndefined();
    await expect(vault.listVaults()).resolves.toBeUndefined();
  });
});
