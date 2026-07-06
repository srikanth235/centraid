/*
 * The enricher automation templates (issue #299 phases 1–2): their
 * manifests must parse under the runtime's real validator (vault block +
 * data trigger coherence), their handlers must pass the determinism lint,
 * and — driven with a stub ctx — they must enforce the spine's contract:
 * derivatives only, stage-don't-write, cursor watermarks, honest skips.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { lintHandlerSource, parseManifest } from '@centraid/automation';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ENRICHERS = [
  'photo-captioner',
  'doc-text-extractor',
  'screenshot-extractor',
  'doc-filer',
  'face-proposer',
  'trip-albums',
] as const;

/** Trip clustering is deterministic code, so it wakes on cron, not data. */
const CRON_ENRICHERS = new Set(['trip-albums']);

function automationDir(id: string): string {
  return path.join(PACKAGE_ROOT, 'automations', id, 'automations', id);
}

async function loadHandler(id: string): Promise<(args: unknown) => Promise<unknown>> {
  const mod = (await import(pathToFileURL(path.join(automationDir(id), 'handler.js')).href)) as {
    default: (args: unknown) => Promise<unknown>;
  };
  return mod.default;
}

/** A recording stub ctx: canned reads/agent turns, captured invokes. */
function stubCtx(options: {
  reads: Record<string, Record<string, unknown>[]>;
  agent?: (call: {
    prompt: string;
    json?: unknown;
    content?: { contentId: string; variant: string }[];
  }) => unknown;
}) {
  const invokes: { command: string; input: Record<string, unknown> }[] = [];
  const agentCalls: { prompt: string; content?: { contentId: string; variant: string }[] }[] = [];
  const state = new Map<string, unknown>();
  const logs: string[] = [];
  const ctx = {
    vault: {
      read: async (request: { entity: string }) => ({
        rows: options.reads[request.entity] ?? [],
        receiptId: 'r',
      }),
      invoke: async (request: { command: string; input: Record<string, unknown> }) => {
        invokes.push({ command: request.command, input: request.input });
        return { status: 'executed', output: { batch_id: 'b1' } };
      },
    },
    agent: async (call: {
      prompt: string;
      json?: unknown;
      content?: { contentId: string; variant: string }[];
    }) => {
      agentCalls.push({ prompt: call.prompt, ...(call.content ? { content: call.content } : {}) });
      return options.agent ? options.agent(call) : {};
    },
    state: {
      get: async (k: string) => state.get(k),
      set: async (k: string, v: unknown) => void state.set(k, v),
      delete: async (k: string) => void state.delete(k),
    },
    runs: { last: async () => undefined, list: async () => [] },
    input: undefined,
  };
  const log = {
    info: (m: string) => logs.push(m),
    warn: (m: string) => logs.push(m),
    error: (m: string) => logs.push(m),
  };
  return { ctx, log, invokes, agentCalls, state, logs };
}

describe('enricher template hygiene', () => {
  it.each(ENRICHERS.map((id) => [id] as const))(
    '%s: manifest parses, data trigger + vault block cohere, ships disabled',
    (id) => {
      const manifest = parseManifest(readFileSync(path.join(automationDir(id), 'automation.json'), 'utf8'));
      expect(manifest.enabled).toBe(false); // enabling IS the owner's opt-in
      expect(manifest.vault).toBeDefined();
      expect(
        manifest.triggers.some((t) => t.kind === (CRON_ENRICHERS.has(id) ? 'cron' : 'data')),
      ).toBe(true);
      expect(manifest.connector).toBeUndefined(); // enrichers use ctx.agent — connectors forbid it
    },
  );

  it.each(ENRICHERS.map((id) => [id] as const))('%s: handler passes the determinism lint', (id) => {
    const source = readFileSync(path.join(automationDir(id), 'handler.js'), 'utf8');
    expect(lintHandlerSource(source)).toEqual([]);
  });
});

describe('photo-captioner behavior', () => {
  it('captions via preview only, stages annotation + tags, advances the cursor', async () => {
    const handler = await loadHandler('photo-captioner');
    const harness = stubCtx({
      reads: {
        'media.media_asset': [
          { asset_id: 'a1', content_id: 'c1', kind: 'photo', deleted_at: null },
        ],
        'core.content_derivative': [
          { content_id: 'c1', variant: 'thumb' },
          { content_id: 'c1', variant: 'preview' },
        ],
      },
      agent: () => ({
        caption: 'Two kids at the beach',
        tags: [{ label: 'Beach', confidence: 0.9 }],
      }),
    });
    const result = (await handler({ ctx: harness.ctx, log: harness.log })) as { summary: string };
    // Preview wins over thumb; originals are never a spelling.
    expect(harness.agentCalls[0]!.content).toEqual([{ contentId: 'c1', variant: 'preview' }]);
    expect(harness.invokes.length).toBe(1);
    const staged = harness.invokes[0]!;
    expect(staged.command).toBe('sync.stage_rows');
    expect(staged.input.kind).toBe('enrichment.vision');
    const rows = staged.input.rows as { entity_type: string; external_id: string }[];
    expect(rows.map((r) => r.entity_type)).toEqual(['knowledge.annotation', 'core.tag']);
    expect(rows[0]!.external_id).toBe('a1:caption');
    expect(harness.state.get('cursor')).toBe('a1');
    expect(result.summary).toContain('captioned 1');
  });

  it('a photo without derivatives is skipped honestly — no bytes, no agent turn', async () => {
    const handler = await loadHandler('photo-captioner');
    const harness = stubCtx({
      reads: {
        'media.media_asset': [{ asset_id: 'a2', content_id: 'c2', kind: 'photo' }],
        'core.content_derivative': [],
      },
    });
    const result = (await handler({ ctx: harness.ctx, log: harness.log })) as { summary: string };
    expect(harness.agentCalls.length).toBe(0);
    expect(harness.invokes.length).toBe(0);
    expect(result.summary).toContain('skipped 1');
    // The cursor still advances — a later manual re-run can revisit.
    expect(harness.state.get('cursor')).toBe('a2');
  });
});

describe('doc-text-extractor behavior', () => {
  it('OCRs a scan (no text variant) through core.set_extracted_text', async () => {
    const handler = await loadHandler('doc-text-extractor');
    const harness = stubCtx({
      reads: {
        'core.content_item': [{ content_id: 'd1', media_type: 'application/pdf' }],
        'core.content_derivative': [{ content_id: 'd1', variant: 'preview' }],
      },
      agent: () => ({ text: 'Warranty expires 2027-03-01' }),
    });
    const result = (await handler({ ctx: harness.ctx, log: harness.log })) as { summary: string };
    expect(harness.agentCalls[0]!.content).toEqual([{ contentId: 'd1', variant: 'preview' }]);
    expect(harness.invokes.map((i) => i.command)).toEqual(['core.set_extracted_text']);
    expect(harness.invokes[0]!.input).toEqual({
      content_id: 'd1',
      text: 'Warranty expires 2027-03-01',
    });
    expect(result.summary).toContain('OCRed 1');
  });

  it('summarizes a document that already has text, staged as an annotation', async () => {
    const handler = await loadHandler('doc-text-extractor');
    const harness = stubCtx({
      reads: {
        'core.content_item': [{ content_id: 'd2', media_type: 'application/pdf' }],
        'core.content_derivative': [{ content_id: 'd2', variant: 'text' }],
      },
      agent: () => ({ summary: 'Home insurance policy for 2026.' }),
    });
    await handler({ ctx: harness.ctx, log: harness.log });
    expect(harness.agentCalls[0]!.content).toEqual([{ contentId: 'd2', variant: 'text' }]);
    expect(harness.invokes.map((i) => i.command)).toEqual(['sync.stage_rows']);
    const rows = harness.invokes[0]!.input.rows as { external_id: string; payload: { body: string } }[];
    expect(rows[0]!.external_id).toBe('d2:summary');
    expect(rows[0]!.payload.body).toContain('insurance');
  });

  it('inline text items and underivable binaries are skipped without agent turns', async () => {
    const handler = await loadHandler('doc-text-extractor');
    const harness = stubCtx({
      reads: {
        'core.content_item': [
          { content_id: 'd3', media_type: 'text/plain' },
          { content_id: 'd4', media_type: 'application/pdf' },
        ],
        'core.content_derivative': [],
      },
    });
    const result = (await handler({ ctx: harness.ctx, log: harness.log })) as { summary: string };
    expect(harness.agentCalls.length).toBe(0);
    expect(harness.invokes.length).toBe(0);
    expect(result.summary).toContain('skipped 1');
  });
});

describe('screenshot-extractor behavior', () => {
  it('a receipt with a visible date stages a core.transaction; cross-domain rows always stage', async () => {
    const handler = await loadHandler('screenshot-extractor');
    const harness = stubCtx({
      reads: {
        'media.media_asset': [{ asset_id: 's1', content_id: 'c1', kind: 'photo', exif_json: null }],
        'core.content_derivative': [{ content_id: 'c1', variant: 'thumb' }],
      },
      agent: () => ({
        kind: 'receipt',
        receipt: {
          merchant: 'Blue Tokai',
          amount_minor: 45000,
          currency: 'inr',
          posted_at: '2026-07-01',
        },
      }),
    });
    await handler({ ctx: harness.ctx, log: harness.log });
    expect(harness.invokes.map((i) => i.command)).toEqual(['sync.stage_rows']);
    const input = harness.invokes[0]!.input as {
      kind: string;
      rows: { entity_type: string; payload: Record<string, unknown> }[];
    };
    expect(input.kind).toBe('enrichment.extraction');
    expect(input.rows[0]!.entity_type).toBe('core.transaction');
    expect(input.rows[0]!.payload.amountMinor).toBe(45000);
    expect(input.rows[0]!.payload.currency).toBe('INR');
    expect(input.rows[0]!.payload.postedAt).toBe('2026-07-01');
  });

  it('a dateless booking is dropped, never defaulted', async () => {
    const handler = await loadHandler('screenshot-extractor');
    const harness = stubCtx({
      reads: {
        'media.media_asset': [{ asset_id: 's2', content_id: 'c2', kind: 'photo', exif_json: null }],
        'core.content_derivative': [{ content_id: 'c2', variant: 'preview' }],
      },
      agent: () => ({ kind: 'booking', booking: { summary: 'Flight BLR → GOI' } }),
    });
    const result = (await handler({ ctx: harness.ctx, log: harness.log })) as { summary: string };
    expect(harness.invokes.length).toBe(0);
    expect(result.summary).toContain('0 booking(s)');
  });
});

describe('face-proposer behavior', () => {
  it('proposes identity-blind regions with derived external ids', async () => {
    const handler = await loadHandler('face-proposer');
    const harness = stubCtx({
      reads: {
        'media.media_asset': [{ asset_id: 'f1', content_id: 'c1', kind: 'photo' }],
        'core.content_derivative': [{ content_id: 'c1', variant: 'preview' }],
      },
      agent: (call) => {
        expect(call.prompt).toContain('never describe or identify');
        return {
          faces: [
            { x: 0.1, y: 0.2, w: 0.2, h: 0.25, confidence: 0.9 },
            { x: 0.6, y: 0.3, w: 0.15, h: 0.2, confidence: 0.7 },
          ],
        };
      },
    });
    await handler({ ctx: harness.ctx, log: harness.log });
    const input = harness.invokes[0]!.input as {
      kind: string;
      rows: { entity_type: string; external_id: string; payload: { party_id?: unknown } }[];
    };
    expect(input.kind).toBe('enrichment.faces');
    expect(input.rows.map((r) => r.external_id)).toEqual(['f1:face:0', 'f1:face:1']);
    // Identity-blind: proposals never carry a party.
    expect(input.rows.every((r) => r.payload.party_id === undefined)).toBe(true);
  });
});

describe('trip-albums behavior', () => {
  it('clusters by time gaps deterministically — no agent turns at all', async () => {
    const handler = await loadHandler('trip-albums');
    const trip = Array.from({ length: 6 }, (_, i) => ({
      asset_id: `t${i}`,
      content_id: `tc${i}`,
      kind: 'photo',
      captured_at: `2026-06-1${Math.min(i, 4)}T10:0${i}:00.000Z`, // 5-day spread
    }));
    const homePhotos = [
      { asset_id: 'h1', content_id: 'hc1', kind: 'photo', captured_at: '2026-05-01T09:00:00.000Z' },
      { asset_id: 'h2', content_id: 'hc2', kind: 'photo', captured_at: '2026-05-01T10:00:00.000Z' },
    ];
    const harness = stubCtx({
      reads: { 'media.media_asset': [...homePhotos, ...trip] },
    });
    const result = (await handler({ ctx: harness.ctx, log: harness.log })) as { summary: string };
    expect(harness.agentCalls.length).toBe(0); // deterministic code, no model
    expect(harness.invokes.map((i) => i.command)).toEqual(['sync.stage_rows']);
    const input = harness.invokes[0]!.input as {
      rows: { external_id: string; payload: { name: string; members: unknown[] } }[];
    };
    // The two May photos are too few/short; the June run is one trip.
    expect(input.rows.length).toBe(1);
    expect(input.rows[0]!.external_id).toBe('trip:2026-06-10');
    expect(input.rows[0]!.payload.name).toContain('Jun');
    expect(input.rows[0]!.payload.members.length).toBe(6);
    expect(result.summary).toContain('1 trip album');
  });
});

describe('doc-filer behavior', () => {
  it('proposes title + folder + doctype from the text variant, staged for review', async () => {
    const handler = await loadHandler('doc-filer');
    const harness = stubCtx({
      reads: {
        'core.content_derivative': [
          { derivative_id: 'dv1', content_id: 'd1', variant: 'text' },
        ],
        'core.content_item': [
          { content_id: 'd1', media_type: 'application/pdf', title: 'scan_001' },
        ],
        'core.concept_scheme': [
          { scheme_id: 'sf', uri: 'https://centraid.dev/schemes/folders' },
        ],
        'core.concept': [
          { scheme_id: 'sf', notation: 'insurance', pref_label: 'Insurance' },
          { scheme_id: 'sf', notation: 'root', pref_label: 'Documents' },
        ],
      },
      agent: (call) => {
        // The existing folder labels ride into the prompt.
        expect(call.prompt).toContain('Insurance');
        expect(call.prompt).not.toContain('Documents,');
        return {
          title: 'Home insurance policy 2026',
          folder: 'Insurance',
          doctype: 'policy',
          confidence: 0.9,
        };
      },
    });
    await handler({ ctx: harness.ctx, log: harness.log });
    expect(harness.agentCalls[0]!.content).toEqual([{ contentId: 'd1', variant: 'text' }]);
    expect(harness.invokes.map((i) => i.command)).toEqual(['sync.stage_rows']);
    const input = harness.invokes[0]!.input as {
      kind: string;
      rows: { entity_type: string; external_id: string; payload: Record<string, unknown> }[];
    };
    expect(input.kind).toBe('enrichment.doctype');
    expect(input.rows.map((r) => r.entity_type)).toEqual(['core.content_item', 'core.tag']);
    expect(input.rows[0]!.payload).toEqual({
      content_id: 'd1',
      title: 'Home insurance policy 2026',
      folder: 'Insurance',
    });
    expect(input.rows[1]!.payload.scheme_uri).toBe('urn:centraid:doctype');
    expect(harness.state.get('cursor')).toBe('dv1');
  });
});
