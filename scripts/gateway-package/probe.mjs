#!/usr/bin/env node
/**
 * External info probe for packaged gateway smoke (issue #504).
 * Shared by host-process smoke and container / --base-url mode.
 */

export const INFO_PATH = '/centraid/_gateway/info';

/**
 * Probe a running gateway base URL.
 * @param {string} baseUrl e.g. http://127.0.0.1:8787
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: boolean; status?: number; detail: string }>}
 */
export async function probeGatewayInfo(baseUrl, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const url = `${baseUrl.replace(/\/$/, '')}${INFO_PATH}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    const body = await res.json().catch(() => null);
    // 200 or 401 both prove the listener (auth may be required).
    let ok = res.status === 200 || res.status === 401;
    if (res.status === 200 && body && typeof body.version !== 'string') ok = false;
    return {
      ok,
      status: res.status,
      detail: JSON.stringify({ status: res.status, body }),
    };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Poll until the gateway answers or deadline.
 * @param {string} baseUrl
 * @param {{ deadlineMs?: number; intervalMs?: number }} [opts]
 */
export async function waitForGatewayInfo(baseUrl, opts = {}) {
  const deadlineMs = opts.deadlineMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 200;
  const deadline = Date.now() + deadlineMs;
  let last = { ok: false, detail: 'not attempted' };
  while (Date.now() < deadline) {
    last = await probeGatewayInfo(baseUrl, { timeoutMs: 2_000 });
    if (last.ok) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last;
}
