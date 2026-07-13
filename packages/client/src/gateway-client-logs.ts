/*
 * Renderer-side client for the gateway's realtime log surface
 * (`/centraid/_logs`): a one-shot JSON tail and the replay-then-live
 * SSE stream the Settings → Logs screen renders. Fetch-based SSE (not
 * EventSource) so the Bearer header rides along — same transport as
 * `streamAutomationRun`.
 */

import { auth, authHeaders, doFetch, readJson } from './gateway-client-core.js';

export type GatewayLogLevelDTO = 'info' | 'warn' | 'error';

/** One gateway log line, mirroring the gateway's `GatewayLogEntry`. */
export interface GatewayLogEntryDTO {
  /** Monotonic per-process sequence — resume/dedupe cursor. */
  seq: number;
  /** Epoch ms the line was emitted. */
  ts: number;
  level: GatewayLogLevelDTO;
  message: string;
}

/** One-shot tail of the gateway's buffered log lines. */
export async function fetchGatewayLogs(input?: {
  after?: number;
  limit?: number;
}): Promise<{ entries: GatewayLogEntryDTO[] }> {
  const { baseUrl, token } = await auth();
  const params = new URLSearchParams();
  if (input?.after !== undefined) params.set('after', String(input.after));
  if (input?.limit !== undefined) params.set('limit', String(input.limit));
  const qs = params.toString();
  const res = await doFetch(baseUrl, `/centraid/_logs${qs ? `?${qs}` : ''}`, {
    method: 'GET',
    headers: authHeaders(token),
  });
  return readJson<{ entries: GatewayLogEntryDTO[] }>(res, 'fetch gateway logs');
}

/**
 * Subscribe to gateway log lines over SSE (`GET /centraid/_logs/events`).
 * The gateway replays its ring buffer (past `after`, when given), then
 * streams live until the caller aborts. `onEntry` fires per parsed line;
 * the promise resolves when the stream closes. An abort resolves quietly;
 * other transport failures reject so the caller can schedule a reconnect
 * (passing the last seen `seq` as `after` to dedupe the overlap).
 */
export async function streamGatewayLogs(
  onEntry: (entry: GatewayLogEntryDTO) => void,
  signal: AbortSignal,
  after?: number,
): Promise<void> {
  const { baseUrl, token } = await auth();
  const qs = after !== undefined ? `?after=${encodeURIComponent(String(after))}` : '';
  try {
    const res = await doFetch(baseUrl, `/centraid/_logs/events${qs}`, {
      method: 'GET',
      headers: authHeaders(token),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`gateway log stream failed (HTTP ${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const data = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice('data:'.length).trimStart())
          .join('\n');
        if (!data) continue;
        try {
          const entry = JSON.parse(data) as GatewayLogEntryDTO;
          if (entry && typeof entry.seq === 'number' && typeof entry.message === 'string') {
            onEntry(entry);
          }
        } catch {
          /* skip a malformed frame rather than abort the stream */
        }
      }
    }
  } catch (err) {
    // A caller-initiated abort is a normal teardown, not a failure.
    if (signal.aborted) return;
    throw err;
  }
}
