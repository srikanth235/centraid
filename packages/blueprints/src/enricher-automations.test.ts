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

const ENRICHERS = ['photo-captioner', 'doc-text-extractor'] as const;

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
      expect(manifest.triggers.some((t) => t.kind === 'data')).toBe(true);
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
