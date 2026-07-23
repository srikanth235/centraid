import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface FetchResult {
  status: number;
  headers: Record<string, string>;
  text: string;
}

interface PullContext {
  now: string;
  fetch(spec: { url: string }): Promise<FetchResult>;
}

interface CursorStrategy {
  readonly current: unknown;
  set(value: unknown): void;
  clear(): void;
  observe(value: unknown): void;
}

interface PullSpec {
  principal(args: { ctx: PullContext }): Promise<string>;
  pull(args: {
    ctx: PullContext;
    cursor: {
      provider(key: string): CursorStrategy;
      highWater(key: string): CursorStrategy;
    };
    log: { info(message: string): void; warn(message: string): void };
  }): Promise<{ rows: Array<Record<string, unknown>> }>;
}

async function loadPull(id: string): Promise<PullSpec> {
  const handler = path.join(PACKAGE_ROOT, 'automations', id, 'automations', id, 'handler.js');
  const loaded = (await import(`${pathToFileURL(handler).href}?test=${id}`)) as {
    default: PullSpec;
  };
  return loaded.default;
}

function json(value: unknown, headers: Record<string, string> = {}): FetchResult {
  return { status: 200, headers, text: JSON.stringify(value) };
}

function cursorHarness(initial: Record<string, unknown> = {}): {
  cursor: {
    provider(key: string): CursorStrategy;
    highWater(key: string): CursorStrategy;
  };
  updates: Map<string, unknown>;
} {
  const updates = new Map<string, unknown>();
  const provider = (key: string): CursorStrategy => ({
    current: initial[key],
    set(value) {
      updates.set(key, value);
    },
    clear() {
      updates.set(key, null);
    },
    observe() {
      throw new Error(`provider cursor ${key} cannot observe`);
    },
  });
  const highWater = (key: string): CursorStrategy => {
    let next = initial[key];
    return {
      current: initial[key],
      set() {
        throw new Error(`high-water cursor ${key} cannot set`);
      },
      clear() {
        throw new Error(`high-water cursor ${key} cannot clear`);
      },
      observe(value) {
        const comparable = value === null || value === undefined ? undefined : String(value);
        const previous = next === null || next === undefined ? undefined : String(next);
        if (comparable !== undefined && (previous === undefined || comparable > previous)) {
          next = value;
          updates.set(key, value);
        }
      },
    };
  };
  return { cursor: { provider, highWater }, updates };
}

const log = { info() {}, warn() {} };

describe('bundled pull handler correctness', () => {
  it('drains every Gmail history page before advancing historyId', async () => {
    const spec = await loadPull('google-gmail-pull');
    let historyCalls = 0;
    const ctx: PullContext = {
      now: '2026-07-23T00:00:00.000Z',
      async fetch({ url }) {
        if (url.endsWith('/profile')) {
          return json({ emailAddress: 'owner@example.com', historyId: '200' });
        }
        if (url.includes('/history?')) {
          historyCalls += 1;
          if (url.includes('pageToken=next')) {
            return json({
              history: [{ messagesAdded: [{ message: { id: 'm101' } }] }],
            });
          }
          return json({
            history: Array.from({ length: 100 }, (_, index) => ({
              messagesAdded: [{ message: { id: `m${index + 1}` } }],
            })),
            nextPageToken: 'next',
          });
        }
        const id = /\/messages\/([^?]+)/.exec(url)?.[1];
        if (id) {
          return json({
            id,
            threadId: `thread-${id}`,
            internalDate: '1760000000000',
            snippet: id,
            payload: { headers: [] },
          });
        }
        throw new Error(`unexpected Gmail URL ${url}`);
      },
    };
    await expect(spec.principal({ ctx })).resolves.toBe('owner@example.com');
    const harness = cursorHarness({ 'gmail.historyId': '100' });
    const result = await spec.pull({ ctx, cursor: harness.cursor, log });

    expect(historyCalls).toBe(2);
    expect(result.rows).toHaveLength(101);
    expect(harness.updates.get('gmail.historyId')).toBe('200');
  });

  it('drains GitLab pages with independent issue and merge-request watermarks', async () => {
    const spec = await loadPull('gitlab-pull');
    const requested: string[] = [];
    const item = (kind: string, index: number) => ({
      id: `${kind}-${index}`,
      iid: index,
      title: `${kind} ${index}`,
      state: 'opened',
      updated_at: `2026-07-23T00:${String(index % 60).padStart(2, '0')}:00Z`,
      web_url: `https://gitlab.com/example/${kind}/${index}`,
    });
    const ctx: PullContext = {
      now: '2026-07-23T00:00:00.000Z',
      async fetch({ url }) {
        requested.push(url);
        if (url.endsWith('/user')) return json({ username: 'owner' });
        const page = Number(new URL(url).searchParams.get('page'));
        if (url.includes('/issues?')) {
          return json(
            page === 1
              ? Array.from({ length: 100 }, (_, i) => item('issue', i))
              : [item('issue', 100)],
          );
        }
        if (url.includes('/merge_requests?')) return json([item('mr', 1)]);
        throw new Error(`unexpected GitLab URL ${url}`);
      },
    };
    const harness = cursorHarness({
      'gitlab.issues.updated_after': '2026-07-20T00:00:00Z',
      'gitlab.merge_requests.updated_after': '2026-07-21T00:00:00Z',
    });
    const result = await spec.pull({ ctx, cursor: harness.cursor, log });

    expect(result.rows).toHaveLength(102);
    expect(requested.filter((url) => url.includes('/issues?'))).toHaveLength(2);
    expect(requested.filter((url) => url.includes('/merge_requests?'))).toHaveLength(1);
    expect(harness.updates.has('gitlab.issues.updated_after')).toBe(true);
    expect(harness.updates.has('gitlab.merge_requests.updated_after')).toBe(true);
    expect(requested.find((url) => url.includes('/issues?'))).toContain('updated_after=2026-07-20');
    expect(requested.find((url) => url.includes('/merge_requests?'))).toContain(
      'updated_after=2026-07-21',
    );
  });

  it('keys Slack messages by immutable channel id while retaining the display name', async () => {
    const spec = await loadPull('slack-pull');
    const ctx: PullContext = {
      now: '2026-07-23T00:00:00.000Z',
      async fetch({ url }) {
        if (url.endsWith('/auth.test')) return json({ ok: true, user_id: 'U1' });
        if (url.includes('/conversations.list?')) {
          return json({ ok: true, channels: [{ id: 'C123', name: 'renamed-channel' }] });
        }
        if (url.includes('/conversations.history?')) {
          return json({ ok: true, messages: [{ ts: '100.25', text: 'hello' }] });
        }
        throw new Error(`unexpected Slack URL ${url}`);
      },
    };
    const result = await spec.pull({ ctx, cursor: cursorHarness().cursor, log });

    expect(result.rows[0]).toMatchObject({
      external_id: 'slack:C123:100.25',
      payload: {
        messageId: 'slack:C123:100.25',
        subject: 'Slack · renamed-channel',
        threadKey: 'slack:C123:100.25',
      },
    });
  });

  it('pins Todoist identity to the account-specific Inbox project', async () => {
    const spec = await loadPull('todoist-pull');
    const ctx: PullContext = {
      now: '2026-07-23T00:00:00.000Z',
      async fetch({ url }) {
        if (url.endsWith('/projects')) {
          return json([
            { id: 'project-other', is_inbox_project: false },
            { id: 'project-inbox', is_inbox_project: true },
          ]);
        }
        throw new Error(`unexpected Todoist URL ${url}`);
      },
    };

    await expect(spec.principal({ ctx })).resolves.toBe('todoist:project-inbox');
  });

  it('pins Notion identity to its stable API user id, not a display name', async () => {
    const spec = await loadPull('notion-pull');
    const ctx: PullContext = {
      now: '2026-07-23T00:00:00.000Z',
      async fetch({ url }) {
        if (url.endsWith('/users/me')) {
          return json({
            id: 'bot-stable-123',
            name: 'Shared Owner',
            bot: { owner: { user: { id: 'owner-456', name: 'Shared Owner' } } },
          });
        }
        throw new Error(`unexpected Notion URL ${url}`);
      },
    };

    await expect(spec.principal({ ctx })).resolves.toBe('notion:bot-stable-123');
  });

  it('restarts Microsoft Calendar delta when its encoded horizon goes stale', async () => {
    const spec = await loadPull('microsoft-calendar-pull');
    const requested: string[] = [];
    const ctx: PullContext = {
      now: '2026-07-23T00:00:00.000Z',
      async fetch({ url }) {
        requested.push(url);
        return json({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/new-delta' });
      },
    };
    const harness = cursorHarness({
      'outlookcal.deltaLink': 'https://graph.microsoft.com/frozen-delta',
      'outlookcal.windowEnd': '2028-01-01T00:00:00.000Z',
    });
    await spec.pull({ ctx, cursor: harness.cursor, log });

    expect(requested[0]).toContain('/me/calendarView/delta?');
    expect(requested[0]).not.toContain('frozen-delta');
    expect(harness.updates.get('outlookcal.deltaLink')).toBe(
      'https://graph.microsoft.com/new-delta',
    );
    expect(harness.updates.get('outlookcal.windowEnd')).toBe('2028-07-23T00:00:00.000Z');
  });
});
