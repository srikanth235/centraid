// Shared consent / parked-write flow (issue #420) — the ONE state machine for
// turning a parked vault invocation into an Approve/Discard decision. Canonical
// copy: packages/blueprints/kit/consent-cards.js. Extracted from the kit Ask
// panel's vault driver (the more complete of the two surfaces' flows) so any
// chat surface can adopt the same logic; the per-surface card chrome stays with
// each surface, but the wire flow — probe a tool result for a parked outcome,
// look the invocation up on the consent surface, describe it, post the owner's
// decision, normalize the result — is shared here.
//
// Transport is injected: `fetchJson(url, opts?) => Promise<{ok, status, body}>`
// (the kit's relative-fetch helper, or any auth-aware equivalent) plus the
// route builders from conversation-client.js.

import { parkedListPath, parkedDecisionPath } from './conversation-client.js';

/**
 * Probe a tool result for a vault `InvokeOutcome` — bare, or nested under
 * `output`. Returns the outcome object (with its `status`) or null.
 * @param {unknown} x The tool result to inspect.
 * @returns {{ status: string, [k: string]: unknown } | null} The nested or bare outcome.
 */
export function outcomeOf(x) {
  if (!x || typeof x !== 'object') return null;
  if (typeof x.status === 'string') return x;
  if (x.output && typeof x.output === 'object' && typeof x.output.status === 'string') {
    return x.output;
  }
  return null;
}

/** Truncate a value for one-line display in a proposed-write card. */
export function shortVal(v) {
  let s = typeof v === 'string' ? v : JSON.stringify(v);
  s = String(s == null ? '' : s);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

/**
 * Turn a parked-invocation entry into a human title + detail line for a card.
 * @param {{ command?: string, caller?: string, input?: Record<string, unknown> }} entry The parked invocation.
 * @returns {{ title: string, detail: string }} The card title and detail text.
 */
export function describeParked(entry) {
  const input = entry.input || {};
  const detail = Object.keys(input)
    .map((k) => `${k}: ${shortVal(input[k])}`)
    .join(' · ');
  return {
    title: entry.command ?? 'Proposed write',
    detail: (entry.caller ? `${entry.caller} · ` : '') + (detail || 'no input'),
  };
}

/**
 * Look up a freshly-parked invocation on the consent surface. Returns the
 * matching entry, or null when it's no longer pending (handled elsewhere).
 * @param {string} invocationId The parked invocation identifier.
 * @param {{ fetchJson: (url: string, opts?: object) => Promise<{ ok: boolean, status: number, body: any }> }} deps The injected transport.
 * @returns {Promise<any | null>} The matching parked entry, if still pending.
 */
export async function fetchParkedEntry(invocationId, deps) {
  const r = await deps.fetchJson(parkedListPath());
  const list = (r.ok && r.body && r.body.parked) || [];
  return list.find((p) => p.invocationId === invocationId) ?? null;
}

/**
 * Post the owner's decision on one parked invocation; returns the raw
 * `InvokeOutcome`. Throws with the server's message on a non-ok response.
 * @param {string} invocationId The parked invocation identifier.
 * @param {boolean} approve Whether the owner approved the write.
 * @param {{ fetchJson: (url: string, opts?: object) => Promise<{ ok: boolean, status: number, body: any }> }} deps The injected transport.
 * @returns {Promise<any>} The gateway's resulting invocation outcome.
 */
export async function confirmParked(invocationId, approve, deps) {
  const r = await deps.fetchJson(parkedDecisionPath(invocationId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approve }),
  });
  if (!r.ok) {
    throw new Error(
      (r.body && (r.body.message || r.body.error)) || `confirmation failed (${r.status})`,
    );
  }
  return r.body;
}

/**
 * Normalize an approve `InvokeOutcome` into the card's settle shape:
 * `{ ok: true, receipt }` on executed/replayed, `{ ok: false, note }` otherwise.
 * @param {{ status?: string, receiptId?: string, reason?: string } | null} outcome The approval outcome.
 * @returns {{ ok: true, receipt: string } | { ok: false, note: string }} The card settle state.
 */
export function normalizeApproveOutcome(outcome) {
  if (outcome && outcome.status === 'executed') {
    return { ok: true, receipt: `approved · receipt ${outcome.receiptId}` };
  }
  if (outcome && outcome.status === 'replayed') {
    return { ok: true, receipt: 'already applied' };
  }
  return {
    ok: false,
    note: (outcome && outcome.reason) || 'The vault refused this write.',
  };
}
