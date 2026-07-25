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

  it('exhausts every Gmail history page before advancing the history cursor', async () => {
    const poll = vi.fn(async (_connection, url) => {
      const pageToken = new URL(url).searchParams.get('pageToken');
      return pageToken
        ? {
            status: 200,
            headers: {},
            body: {
              historyId: '110',
              history: [
                {
                  id: '109',
                  messagesAdded: [{ message: { id: 'message-2', threadId: 'thread-2' } }],
                },
              ],
            },
          }
        : {
            status: 200,
            headers: {},
            body: {
              historyId: '110',
              nextPageToken: 'page-2',
              history: [
                {
                  id: '108',
                  messagesAdded: [{ message: { id: 'message-1', threadId: 'thread-1' } }],
                },
              ],
            },
          };
    }) satisfies PollJson;
    const next = await pollProviderEventSource({
      trigger: { kind: 'event', connectorKind: 'pull.gmail', event: 'new-message' },
      connection: gmail,
      cursor: { provider: 'gmail', historyId: '100' },
      now: new Date('2026-07-25T00:05:00Z'),
      limit: 1,
      pollJson: poll,
    });
    expect(poll).toHaveBeenCalledTimes(2);
    expect(new URL(vi.mocked(poll).mock.calls[1]![1]).searchParams.get('pageToken')).toBe('page-2');
    expect(next.cursor).toEqual({ provider: 'gmail', historyId: '110' });
    // The adapter returns the complete provider window. The durable ingress
    // layer applies the fire cap and can therefore record the exact overflow.
    expect(next.events.map((event) => event.id)).toEqual([
      'gmail:message:message-1',
      'gmail:message:message-2',
    ]);
    expect(next.skipped).toBeUndefined();
  });

  it('re-baselines an over-budget Gmail window and records the unknown tail gap', async () => {
    let historyRequests = 0;
    let profileRequests = 0;
    const poll = vi.fn(async (_connection, url) => {
      if (url.endsWith('/profile')) {
        profileRequests++;
        return { status: 200, headers: {}, body: { historyId: '999' } };
      }
      historyRequests++;
      return {
        status: 200,
        headers: {},
        body: { historyId: '900', nextPageToken: `page-${historyRequests + 1}`, history: [] },
      };
    }) satisfies PollJson;
    const next = await pollProviderEventSource({
      trigger: { kind: 'event', connectorKind: 'pull.gmail', event: 'new-message' },
      connection: gmail,
      cursor: { provider: 'gmail', historyId: '100' },
      now: new Date('2026-07-25T00:05:00Z'),
      limit: 50,
      pollJson: poll,
    });
    expect(historyRequests).toBe(100);
    expect(profileRequests).toBe(1);
    expect(next).toEqual({
      events: [],
      cursor: { provider: 'gmail', historyId: '999' },
      skipped: 1,
      gapReason: 'gmail_history_page_limit',
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

  it('follows every safe GitHub events page and emits the complete oldest-first window', async () => {
    const issueEvent = (id: string, second: number) => ({
      id,
      type: 'IssuesEvent',
      created_at: `2026-07-25T00:00:0${second}Z`,
      payload: {
        action: 'opened',
        issue: {
          number: second,
          title: `Issue ${second}`,
          state: 'open',
          html_url: `https://github.com/acme/app/issues/${second}`,
          created_at: `2026-07-25T00:00:0${second}Z`,
          user: { login: 'octo' },
        },
      },
    });
    const poll = replies(
      {
        status: 200,
        headers: {
          etag: '"events-all"',
          link: '<https://api.github.com/repos/acme/app/events?per_page=1&page=2>; rel="next"',
        },
        body: [issueEvent('2', 2)],
      },
      {
        status: 200,
        headers: {},
        body: [issueEvent('1', 1)],
      },
    );
    const next = await pollProviderEventSource({
      trigger: {
        kind: 'event',
        connectorKind: 'pull.github',
        event: 'issue',
        filter: { repo: 'acme/app' },
      },
      connection: github,
      cursor: { provider: 'github', etag: '"events-old"' },
      now: new Date('2026-07-25T00:01:00Z'),
      limit: 1,
      pollJson: poll,
    });
    expect(poll).toHaveBeenCalledTimes(2);
    expect(vi.mocked(poll).mock.calls[1]![1]).toContain('page=2');
    expect(vi.mocked(poll).mock.calls[1]![2]).toBeUndefined();
    expect(next.events.map((event) => event.id)).toEqual(['github:event:1', 'github:event:2']);
    expect(next.cursor).toMatchObject({ provider: 'github', etag: '"events-all"' });
  });

  it('fails closed for unsupported adapters, events, and malformed repository filters', async () => {
    const base = {
      connection: github,
      now: new Date('2026-07-25T00:00:00Z'),
      limit: 50,
      pollJson: replies(),
    };
    expect(() =>
      pollProviderEventSource({
        ...base,
        trigger: { kind: 'event', connectorKind: 'push.slack', event: 'message' },
      }),
    ).toThrow('no event cursor adapter');
    await expect(
      pollProviderEventSource({
        ...base,
        connection: gmail,
        trigger: { kind: 'event', connectorKind: 'pull.gmail', event: 'deleted-message' },
      }),
    ).rejects.toThrow('unsupported Gmail event');
    await expect(
      pollProviderEventSource({
        ...base,
        trigger: {
          kind: 'event',
          connectorKind: 'pull.github',
          event: 'release',
          filter: { repo: 'acme/app' },
        },
      }),
    ).rejects.toThrow('unsupported GitHub event');
    for (const repo of [undefined, '', 'one-segment', 'owner/repo/extra', 'owner/repo name']) {
      await expect(
        pollProviderEventSource({
          ...base,
          trigger: {
            kind: 'event',
            connectorKind: 'pull.github',
            event: 'issue',
            filter: repo === undefined ? {} : { repo },
          },
        }),
      ).rejects.toThrow('filter.repo');
    }
  });

  it('honors GitHub backoff and baselines a newly authored watcher without replay', async () => {
    const trigger = {
      kind: 'event' as const,
      connectorKind: 'pull.github',
      event: 'issue',
      filter: { repo: 'acme/app' },
    };
    const waitingFetch = vi.fn() satisfies PollJson;
    const waiting = await pollProviderEventSource({
      trigger,
      connection: github,
      cursor: {
        provider: 'github',
        etag: '"old"',
        notBefore: Date.parse('2026-07-25T00:01:00Z'),
      },
      now: new Date('2026-07-25T00:00:00Z'),
      limit: 50,
      pollJson: waitingFetch,
    });
    expect(waiting.events).toEqual([]);
    expect(waitingFetch).not.toHaveBeenCalled();

    const baseline = await pollProviderEventSource({
      trigger,
      connection: github,
      now: new Date('2026-07-25T00:00:00Z'),
      limit: 0,
      pollJson: replies({
        status: 200,
        headers: { etag: '"current"', 'x-poll-interval': 'invalid' },
        body: [{ id: 'historical', type: 'IssuesEvent', payload: { issue: {} } }],
      }),
    });
    expect(baseline.events).toEqual([]);
    expect(baseline.cursor).toMatchObject({
      provider: 'github',
      etag: '"current"',
      notBefore: Date.parse('2026-07-25T00:01:00Z'),
    });
  });

  it('skips malformed provider rows while preserving minimal valid events', async () => {
    const now = new Date('2026-07-25T00:00:00Z');
    const gmailResult = await pollProviderEventSource({
      trigger: { kind: 'event', connectorKind: 'pull.gmail', event: 'new-message' },
      connection: gmail,
      cursor: { provider: 'gmail', historyId: '1' },
      now,
      limit: 1_000,
      pollJson: replies({
        status: 200,
        headers: {},
        body: {
          history: [
            null,
            { id: 7, messagesAdded: 'bad' },
            {
              id: '2',
              messagesAdded: [
                null,
                { message: { threadId: 'missing-id' } },
                { message: { id: 'message-1', labelIds: ['INBOX', 7] } },
              ],
            },
          ],
        },
      }),
    });
    expect(gmailResult.events).toEqual([
      {
        id: 'gmail:message:message-1',
        occurredAt: now.getTime(),
        payload: {
          provider: 'gmail',
          event: 'new-message',
          messageId: 'message-1',
          historyId: '2',
          labelIds: ['INBOX'],
        },
      },
    ]);

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now.getTime());
    const githubResult = await pollProviderEventSource({
      trigger: {
        kind: 'event',
        connectorKind: 'pull.github',
        event: 'issue',
        filter: { repo: 'acme/app' },
      },
      connection: github,
      cursor: { provider: 'github' },
      now,
      limit: 500,
      pollJson: replies({
        status: 200,
        headers: {},
        body: [
          null,
          { id: 'wrong-type', type: 'PushEvent', payload: {} },
          { type: 'IssuesEvent', payload: { issue: {} } },
          { id: 'minimal', type: 'IssuesEvent', payload: { issue: {} } },
        ],
      }),
    });
    expect(githubResult.events).toEqual([
      {
        id: 'github:event:minimal',
        occurredAt: now.getTime(),
        payload: { provider: 'github', event: 'issue', eventId: 'minimal', repo: 'acme/app' },
      },
    ]);
    nowSpy.mockRestore();
  });
});
