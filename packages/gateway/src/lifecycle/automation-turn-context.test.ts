/*
 * Ledger audit budgets (issue #541 review). The regression this guards:
 * `rawJson` rode into `store.openItem`/`closeItem` and into every SSE frame
 * verbatim, while `argsJson`/`outputJson` on the same calls went through
 * `safeJson`'s 64 KiB budget — so one large file-read envelope wrote an
 * unbounded blob into `journal.db` and serialized it to each viewer.
 */

import { expect, test } from 'vitest';
import { boundedRawJson, safeJson } from './automation-turn-context.js';

const BUDGET = 64 * 1024;

test('a rawJson envelope within budget passes through byte-for-byte', () => {
  const raw = JSON.stringify({ sessionUpdate: 'tool_call_update', content: 'x'.repeat(1_000) });
  expect(boundedRawJson(raw)).toBe(raw);
  expect(boundedRawJson(undefined)).toBeUndefined();
});

test('an oversized rawJson envelope is replaced by a bounded truncation marker', () => {
  const raw = JSON.stringify({ content: 'x'.repeat(BUDGET * 2) });
  const bounded = boundedRawJson(raw);
  expect(bounded).toBeDefined();
  expect(bounded!.length).toBeLessThan(1_024);
  expect(JSON.parse(bounded!)).toEqual({
    _truncated: true,
    chars: raw.length,
    head: raw.slice(0, 512),
  });
});

test('rawJson and safeJson share one budget, so neither surface is the loose one', () => {
  const huge = 'y'.repeat(BUDGET * 2);
  const viaSafe = JSON.parse(safeJson({ content: huge })) as { _truncated?: boolean };
  const viaRaw = JSON.parse(boundedRawJson(JSON.stringify({ content: huge }))!) as {
    _truncated?: boolean;
  };
  expect(viaSafe._truncated).toBe(true);
  expect(viaRaw._truncated).toBe(true);
});

test('unserializable values degrade to a marker instead of throwing', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(JSON.parse(safeJson(cyclic))).toEqual({ _truncated: true, reason: 'unserializable' });
});
