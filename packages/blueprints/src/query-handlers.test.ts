// @ts-nocheck
// Directly exercises a few blueprint query handlers (browser ES modules under
// apps/*/queries) with a mocked `ctx.vault`, the way the runtime invokes them
// (`mod.default({ input, query, ctx })` — dispatcher.ts passes the typed input
// as both `input` and `query`). The app-boot harness only proves the apps
// boot with an empty vault; these cover the mobile fast-path projection
// changes (issue #404) that only manifest with content: notes shipping a
// preview + checklist tally instead of full bodies, the on-open body pull, and
// agenda bounding recurring expansion to the visible range.
import { describe, expect, it } from 'vitest';

/** A mock ctx.vault that returns fixture rows keyed by entity name. */
function ctxOf(rowsByEntity: Record<string, unknown[]>) {
  return {
    vault: {
      read: async ({ entity }: { entity: string }) => ({ rows: rowsByEntity[entity] ?? [] }),
      resolve: async () => ({ cards: [] }),
      invoke: async () => ({ status: 'executed', output: { items: [] } }),
      search: async () => ({ rows: rowsByEntity.__search__ ?? [] }),
    },
  };
}

const dataUri = (text: string) => `data:text/markdown,${encodeURIComponent(text)}`;

describe('notes library query (issue #404)', () => {
  const body = ['- [ ] buy milk', '- [x] call bob', '# A heading', 'x'.repeat(250)].join('\n');
  const note = {
    note_id: 'n1',
    title: 'T',
    format: 'markdown',
    pinned: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    body_content_id: 'c1',
  };
  const content = { content_id: 'c1', content_uri: dataUri(body) };

  it('ships a bounded preview + checklist tally, never the full body', async () => {
    const { default: library } = await import('../apps/notes/queries/library.js');
    const ctx = ctxOf({ 'knowledge.note': [note], 'core.content_item': [content] });
    const res = await library({ input: { limit: 50 }, query: {}, ctx });
    expect(res.notes).toHaveLength(1);
    const row = res.notes[0];
    // No full body on the wire anymore.
    expect(row.body).toBeUndefined();
    // Checklist tally computed server-side (2 boxes, 1 done).
    expect(row.check).toEqual({ total: 2, done: 1 });
    // Preview is short and glyphs the checklist, dropping the heading.
    expect(typeof row.preview).toBe('string');
    expect(row.preview.length).toBeLessThanOrEqual(200);
    expect(row.preview).toContain('☐ buy milk');
    expect(row.preview).toContain('☑ call bob');
    expect(row.preview).not.toContain('heading');
  });

  it('note query decodes and returns the full canonical body on open', async () => {
    const { default: noteQuery } = await import('../apps/notes/queries/note.js');
    const ctx = ctxOf({ 'knowledge.note': [note], 'core.content_item': [content] });
    const res = await noteQuery({ input: { note_id: 'n1' }, query: { note_id: 'n1' }, ctx });
    expect(res.note_id).toBe('n1');
    expect(res.body).toBe(body);
  });
});

describe('agenda upcoming query — range-bounded recurrence (issue #404)', () => {
  const ev = {
    event_id: 'e1',
    summary: 'Daily standup',
    dtstart: '2026-01-01T09:00:00.000Z',
    dtend: '2026-01-01T10:00:00.000Z',
    rrule: 'FREQ=DAILY',
    status: 'confirmed',
    sequence: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: 'u1',
  };

  async function run(range: { from: string; to?: string }) {
    const { default: upcoming } = await import('../apps/agenda/queries/upcoming.js');
    const ctx = ctxOf({ 'core.event': [ev] });
    return upcoming({ query: range, input: range, ctx });
  }

  it('expands a daily series only within an explicit [from, to] window (+ buffer)', async () => {
    const res = await run({ from: '2026-06-01T00:00:00.000Z', to: '2026-06-08T00:00:00.000Z' });
    // A one-week window (plus the ~31d span buffer back of `from`) — a couple
    // dozen instances, NOT a year's worth.
    expect(res.events.length).toBeGreaterThan(30);
    expect(res.events.length).toBeLessThan(45);
    // Every instance sits inside [fromLower, to).
    for (const e of res.events) {
      expect(e.dtstart >= '2026-05-01T00:00:00.000Z').toBe(true);
      expect(e.dtstart < '2026-06-08T00:00:00.000Z').toBe(true);
    }
  });

  it('caps open-ended (no `to`) expansion to a bounded forward window, not a year', async () => {
    const bounded = await run({ from: '2026-06-01T00:00:00.000Z' });
    // The 120-day default window would yield ~150 daily instances; the old
    // 366-day ceiling would hit expandRrule's 200 backstop. Assert we're well
    // under that ceiling AND larger than the one-week window above.
    expect(bounded.events.length).toBeLessThan(190);
    expect(bounded.events.length).toBeGreaterThan(120);
  });

  it('is idempotent across repeated reads of the same range (memoized expansion)', async () => {
    const a = await run({ from: '2026-06-01T00:00:00.000Z', to: '2026-06-08T00:00:00.000Z' });
    const b = await run({ from: '2026-06-01T00:00:00.000Z', to: '2026-06-08T00:00:00.000Z' });
    expect(b.events.map((e) => e.instance_key)).toEqual(a.events.map((e) => e.instance_key));
  });
});
