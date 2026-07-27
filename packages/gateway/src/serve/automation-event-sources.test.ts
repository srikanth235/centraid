// Gmail history cursors (bootstrap, expiry re-baseline, page exhaustion, the
// over-budget tail gap) plus the cross-provider fail-closed and malformed-row
// contracts. GitHub conditional cursors / pagination / backoff live in
// automation-event-sources-github.test.ts; provider failures in
// automation-event-sources-errors.test.ts. Shared fixtures in
// automation-event-sources.test-fixtures.ts.

import { describe, expect, it, vi } from 'vitest';
import { pollProviderEventSource, type PollJson } from './automation-event-sources.js';
import { github, gmail, replies } from './automation-event-sources.test-fixtures.js';

describe(pollProviderEventSource, () => {
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
    expect(baseline).toStrictEqual({
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
    expect(next.cursor).toStrictEqual({ provider: 'gmail', historyId: '105' });
    expect(next.events).toStrictEqual([
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
    expect(next).toStrictEqual({
      events: [],
      cursor: { provider: 'gmail', historyId: '900' },
      skipped: 1,
      gapReason: 'gmail_history_expired',
    });
  });

  it('exhausts every Gmail history page before advancing the history cursor', async () => {
    const poll = vi.fn<PollJson>(async (_connection, url) => {
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
    expect(next.cursor).toStrictEqual({ provider: 'gmail', historyId: '110' });
    // The adapter returns the complete provider window. The durable ingress
    // layer applies the fire cap and can therefore record the exact overflow.
    expect(next.events.map((event) => event.id)).toStrictEqual([
      'gmail:message:message-1',
      'gmail:message:message-2',
    ]);
    expect(next.skipped).toBeUndefined();
  });

  it('re-baselines an over-budget Gmail window and records the unknown tail gap', async () => {
    let historyRequests = 0;
    let profileRequests = 0;
    const poll = vi.fn<PollJson>(async (_connection, url) => {
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
    expect(next).toStrictEqual({
      events: [],
      cursor: { provider: 'gmail', historyId: '999' },
      skipped: 1,
      gapReason: 'gmail_history_page_limit',
    });
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
    expect(gmailResult.events).toStrictEqual([
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
    expect(githubResult.events).toStrictEqual([
      {
        id: 'github:event:minimal',
        occurredAt: now.getTime(),
        payload: { provider: 'github', event: 'issue', eventId: 'minimal', repo: 'acme/app' },
      },
    ]);
    nowSpy.mockRestore();
  });
});
