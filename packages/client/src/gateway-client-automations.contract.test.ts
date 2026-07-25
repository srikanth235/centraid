// The app, automation, turn, health, compile, and lifecycle wire surfaces of
// the renderer gateway client — including the `run.*` → `turn.*` rename pinned
// method-and-query deep (#541). Owner vault / import / outbox / log transports
// live in gateway-client-vault.contract.test.ts; the mock gateway itself in
// gateway-client-contract-fixtures.ts.

import { describe, expect, it } from 'vitest';
import {
  client,
  compile,
  editing,
  fetchMock,
  installGatewayContractHarness,
  state,
} from './gateway-client-contract-fixtures.js';

installGatewayContractHarness();

describe('renderer gateway automation contracts', () => {
  it('covers the app, turn, health, compile, and lifecycle surfaces', async () => {
    await expect(client.readGatewayCapabilities()).resolves.toMatchObject({
      automationTurns: true,
    });
    await expect(client.appLiveUrl({ id: 'daily' })).resolves.toEqual({
      url: 'https://gateway.test/centraid/daily/',
    });
    state.hostAppSessions = true;
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

    const requests = fetchMock.mock.calls.map(([url, init]) => {
      const parsed = new URL(String(url));
      return {
        method: (init as RequestInit | undefined)?.method ?? 'GET',
        path: parsed.pathname,
        query: parsed.searchParams,
      };
    });
    const paths = requests.map((request) => request.path);
    expect(paths).toContain('/centraid/_automations/compile');
    expect(paths).toContain('/centraid/_automations/revise');
    expect(paths).toContain('/centraid/_automations/set-enabled');
    expect(paths).toContain('/centraid/_apps/_sessions/desktop-daily');

    // The `run.*` → `turn.*` wire surface, pinned method + query and all:
    // a path assertion alone cannot catch a GET that should be a POST or a
    // dropped query parameter (#541).
    const sent = (
      path: string,
      predicate: (query: URLSearchParams) => boolean = () => true,
      method = 'GET',
    ): boolean =>
      requests.some(
        (request) => request.path === path && request.method === method && predicate(request.query),
      );

    // A manual fire mints a turn — a write, never a GET.
    expect(
      sent('/centraid/_automations/turn-now', (q) => q.get('ref') === 'daily/daily', 'POST'),
    ).toBe(true);
    // The turn feed carries both its filter and its bound.
    expect(
      sent(
        '/centraid/_automations/turns',
        (q) => q.get('ref') === 'daily/daily' && q.get('limit') === '3',
      ),
    ).toBe(true);
    // …and defaults the bound when the caller omits it.
    expect(
      sent('/centraid/_automations/turns', (q) => !q.has('ref') && q.get('limit') === '50'),
    ).toBe(true);
    // The expanded read must ask for items, or the thread renders a bare turn.
    expect(
      sent(
        '/centraid/_automations/turn',
        (q) => q.get('turnId') === 'turn-1' && q.get('expand') === 'items',
      ),
    ).toBe(true);
    expect(
      sent(
        '/centraid/_automations/turn',
        (q) => q.get('ref') === 'daily/daily' && q.get('expand') === 'items',
      ),
    ).toBe(true);
    // A plain turn read must NOT expand — that is the cheap header path.
    expect(
      sent('/centraid/_automations/turn', (q) => q.get('turnId') === 'turn-1' && !q.has('expand')),
    ).toBe(true);
    expect(sent('/centraid/_automations/turn/items', (q) => q.get('turnId') === 'turn-1')).toBe(
      true,
    );
    expect(sent('/centraid/_automations/turn/events', (q) => q.get('turnId') === 'turn-1')).toBe(
      true,
    );
    // An interactive turn posts to the automation ref, not a turn id.
    expect(sent('/centraid/_automations/turn', (q) => q.get('ref') === 'daily/daily', 'POST')).toBe(
      true,
    );
    expect(
      sent('/centraid/_automations/turn/pin', (q) => q.get('turnId') === 'turn-1', 'POST'),
    ).toBe(true);
  });

  it('fails a client that calls a path the gateway does not serve', () => {
    // The retired `run.*` surface is the concrete regression this guards: a
    // renamed or misspelled path must break the suite, not fall through to a
    // permissive `{ ok: true }`.
    expect(() => fetch('https://gateway.test/centraid/_automations/runs?ref=daily/daily')).toThrow(
      /unrouted gateway path: GET \/centraid\/_automations\/runs/,
    );
  });
});
