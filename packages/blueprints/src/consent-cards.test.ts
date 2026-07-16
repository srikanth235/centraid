/* oxlint-disable typescript-eslint/ban-ts-comment -- imports the untyped browser
   kit module (plain JS); suppressing per-file matches kit-smoke.test.ts. */
// @ts-nocheck — exercises the untyped browser kit module (plain JS) directly.
// Unit tests for the shared consent / parked-write flow (issue #420) — the ONE
// state machine turning a parked vault invocation into an Approve/Discard
// decision.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const PKG = path.resolve(import.meta.dirname, '..');
const url = pathToFileURL(path.resolve(PKG, 'kit/consent-cards.js')).href;
const {
  outcomeOf,
  shortVal,
  describeParked,
  fetchParkedEntry,
  confirmParked,
  normalizeApproveOutcome,
} = await import(url);

describe('outcomeOf', () => {
  it('finds a bare or nested InvokeOutcome, else null', () => {
    expect(outcomeOf({ status: 'parked' })).toEqual({ status: 'parked' });
    expect(outcomeOf({ output: { status: 'denied' } })).toEqual({ status: 'denied' });
    expect(outcomeOf({ nope: 1 })).toBeNull();
    expect(outcomeOf(null)).toBeNull();
  });
});

describe('shortVal + describeParked', () => {
  it('truncates long values', () => {
    expect(shortVal('a'.repeat(80)).endsWith('…')).toBe(true);
    expect(shortVal('short')).toBe('short');
  });

  it('builds a title + caller-prefixed detail line', () => {
    const d = describeParked({
      command: 'add_task',
      caller: 'tasks',
      input: { title: 'Buy milk', due: '2026-07-20' },
    });
    expect(d.title).toBe('add_task');
    expect(d.detail).toBe('tasks · title: Buy milk · due: 2026-07-20');
  });

  it('falls back to "no input" when the invocation carries none', () => {
    expect(describeParked({ command: 'x', input: {} }).detail).toBe('no input');
  });
});

describe('fetchParkedEntry', () => {
  it('finds the matching invocation on the consent surface', async () => {
    const fetchJson = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { parked: [{ invocationId: 'inv-1', command: 'a' }, { invocationId: 'inv-2' }] },
    });
    expect(await fetchParkedEntry('inv-2', { fetchJson })).toEqual({ invocationId: 'inv-2' });
    expect(fetchJson).toHaveBeenCalledWith('/centraid/_vault/parked');
    expect(await fetchParkedEntry('gone', { fetchJson })).toBeNull();
  });
});

describe('confirmParked', () => {
  it('POSTs the decision and returns the outcome body', async () => {
    const fetchJson = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { status: 'executed', receiptId: 'r1' },
    });
    const out = await confirmParked('inv-1', true, { fetchJson });
    expect(out).toEqual({ status: 'executed', receiptId: 'r1' });
    const [url, opts] = fetchJson.mock.calls[0];
    expect(url).toBe('/centraid/_vault/parked/inv-1');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ approve: true });
  });

  it('throws the server message on a non-ok response', async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 409, body: { message: 'stale' } });
    await expect(confirmParked('inv-1', false, { fetchJson })).rejects.toThrow('stale');
  });
});

describe('normalizeApproveOutcome', () => {
  it('maps executed/replayed to ok, everything else to a refusal note', () => {
    expect(normalizeApproveOutcome({ status: 'executed', receiptId: 'r1' })).toEqual({
      ok: true,
      receipt: 'approved · receipt r1',
    });
    expect(normalizeApproveOutcome({ status: 'replayed' })).toEqual({
      ok: true,
      receipt: 'already applied',
    });
    expect(normalizeApproveOutcome({ status: 'denied', reason: 'no grant' })).toEqual({
      ok: false,
      note: 'no grant',
    });
    expect(normalizeApproveOutcome(null)).toEqual({
      ok: false,
      note: 'The vault refused this write.',
    });
  });
});
