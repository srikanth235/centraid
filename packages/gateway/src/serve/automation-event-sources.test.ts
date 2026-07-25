import { describe, expect, it, vi } from 'vitest';
import {
  pollProviderEventSource,
  type PollJson,
  type PollJsonResponse,
} from './automation-event-sources.js';

const gmail = {
  connectionId: 'gmail-account-1',
  kind: 'pull.gmail',
  label: 'Personal Gmail',
};
const github = {
  connectionId: 'github-account-1',
  kind: 'pull.github',
  label: 'Work GitHub',
};

function replies(...responses: PollJsonResponse[]): PollJson {
  return vi.fn(async () => {
    const response = responses.shift();
    if (!response) throw new Error('unexpected provider request');
    return response;
  });
}

describe('pollProviderEventSource', () => {
  it('bootstraps Gmail at the profile historyId, then normalizes new messages', async () => {
    const baselineFetch = replies({
      status: 200,
      headers: {},
      body: { emailAddress: 'owner@example.com', historyId: '100' },
    });
    const baseline = await pollProviderEventSource({
      trigger: { kind: 'event', connectorKind: 'pull.gmail', event: 'new-message' },
      connection: gmail,
      now: new Date('2026-07-25T00:00:00Z'),
      limit: 50,
      pollJson: baselineFetch,
    });
    expect(baseline).toEqual({
      events: [],
      cursor: { provider: 'gmail', historyId: '100' },
    });

    const poll = replies({
      status: 200,
      headers: {},
      body: {
        historyId: '105',
        history: [
          {
            id: '104',
            messagesAdded: [
              {
                message: {
                  id: 'message-1',
                  threadId: 'thread-1',
                  labelIds: ['INBOX', 'UNREAD'],
                },
              },
            ],
          },
        ],
      },
    });
    const next = await pollProviderEventSource({
      trigger: { kind: 'event', connectorKind: 'pull.gmail', event: 'new-message' },
      connection: gmail,
      cursor: baseline.cursor,
      now: new Date('2026-07-25T00:05:00Z'),
      limit: 50,
      pollJson: poll,
    });
    expect(next.cursor).toEqual({ provider: 'gmail', historyId: '105' });
    expect(next.events).toEqual([
      {
        id: 'gmail:message:message-1',
        occurredAt: Date.parse('2026-07-25T00:05:00Z'),
        payload: {
          provider: 'gmail',
          event: 'new-message',
          messageId: 'message-1',
          threadId: 'thread-1',
          historyId: '104',
          labelIds: ['INBOX', 'UNREAD'],
        },
      },
    ]);
    expect(JSON.stringify(next)).not.toMatch(/token|authorization|owner@example\.com/);
  });

  it('re-baselines an expired Gmail cursor and records a gap without backfill', async () => {
    const poll = replies(
      { status: 404, headers: {}, body: { error: { message: 'HistoryId too old' } } },
      { status: 200, headers: {}, body: { historyId: '900' } },
    );
    const next = await pollProviderEventSource({
      trigger: { kind: 'event', connectorKind: 'pull.gmail', event: 'new-message' },
      connection: gmail,
      cursor: { provider: 'gmail', historyId: '1' },
      now: new Date('2026-07-25T00:00:00Z'),
      limit: 50,
      pollJson: poll,
    });
    expect(next).toEqual({
      events: [],
      cursor: { provider: 'gmail', historyId: '900' },
      skipped: 1,
      gapReason: 'gmail_history_expired',
    });
  });

  it('uses GitHub conditional cursors, honors poll interval, and treats 304 as no-op', async () => {
    const firstFetch = replies({
      status: 200,
      headers: {
        etag: '"events-v2"',
        'last-modified': 'Sat, 25 Jul 2026 00:00:00 GMT',
        'x-poll-interval': '90',
      },
      body: [
        {
          id: '2',
          type: 'PullRequestEvent',
          created_at: '2026-07-25T00:00:02Z',
          payload: {
            action: 'opened',
            pull_request: {
              number: 42,
              title: 'Cursor engine',
              state: 'open',
              html_url: 'https://github.com/acme/app/pull/42',
              created_at: '2026-07-25T00:00:02Z',
              updated_at: '2026-07-25T00:00:02Z',
              user: { login: 'octo' },
            },
          },
        },
      ],
    });
    const first = await pollProviderEventSource({
      trigger: {
        kind: 'event',
        connectorKind: 'pull.github',
        event: 'pull-request',
        filter: { repo: 'acme/app' },
      },
      connection: github,
      cursor: { provider: 'github' },
      now: new Date('2026-07-25T00:00:00Z'),
      limit: 50,
      pollJson: firstFetch,
    });
    expect(first.events[0]).toMatchObject({
      id: 'github:event:2',
      payload: { repo: 'acme/app', number: 42, action: 'opened' },
    });
    expect(first.cursor).toMatchObject({
      provider: 'github',
      etag: '"events-v2"',
      notBefore: Date.parse('2026-07-25T00:01:30Z'),
    });

    const secondFetch = vi.fn(async (_connection, _url, headers) => {
      expect(headers).toEqual({
        'if-none-match': '"events-v2"',
        'if-modified-since': 'Sat, 25 Jul 2026 00:00:00 GMT',
      });
      return { status: 304, headers: { 'x-poll-interval': '60' } };
    }) satisfies PollJson;
    const second = await pollProviderEventSource({
      trigger: {
        kind: 'event',
        connectorKind: 'pull.github',
        event: 'pull-request',
        filter: { repo: 'acme/app' },
      },
      connection: github,
      cursor: first.cursor,
      now: new Date('2026-07-25T00:01:31Z'),
      limit: 50,
      pollJson: secondFetch,
    });
    expect(second.events).toEqual([]);
    expect(second.cursor).toMatchObject({
      provider: 'github',
      etag: '"events-v2"',
      notBefore: Date.parse('2026-07-25T00:02:31Z'),
    });
  });
});
