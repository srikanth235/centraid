/*
 * Renderer-side client for the gateway's pre-vault recovery surface (issue
 * #439 R1 wave 4 — `packages/gateway/src/routes/recover-routes.ts`). Backs the
 * fresh-gateway onboarding "Recover my vault" branch (RecoverScreen.tsx): turn
 * a pasted/dropped recovery kit + a provider key into a live vault, and watch
 * the daemon-owned restore over SSE.
 *
 *   POST /centraid/_gateway/recover/kit       validate a kit → sanitized summary
 *   POST /centraid/_gateway/recover/discover  {kit, apiKey} → "found your vault"
 *   POST /centraid/_gateway/recover/start     {kit, apiKey, confirmed?} → {jobId}
 *   GET  /centraid/_gateway/recover/status    {fresh, job} — entry + reattach
 *   GET  /centraid/_gateway/recover/events?job=<id>  progress SSE
 *
 * Admin-bearer gated; the desktop/web shell's `getGatewayAuth()` token works
 * pre-vault (a paired-device token is refused 403 by the gateway). Every method
 * maps the gateway's typed refusals into a result union the screen branches on —
 * NONE of these functions throw for an expected refusal (bad kit, wrong key,
 * not-fresh, metered-confirm), only for an unreachable gateway. The SSE reader
 * mirrors `streamGatewayLogs` (fetch + `res.body.getReader()`, not EventSource —
 * the Bearer header must ride along) and reuses the shared SSE frame grammar.
 */

import { auth, authHeaders, doFetch } from './gateway-client-core.js';
import { decodeFrame, frameBoundary } from './vault-change-sse.js';

const BASE = '/centraid/_gateway/recover';

export type RestoreCostClass = 'free-egress' | 'metered-egress';

/** The daemon's user-facing progress phases (mirror of the gateway's
 *  `RecoverPhase`). These are machine names — the screen maps them to the three
 *  user stages ("fetching your vault" → "replaying recent changes" → "warming
 *  previews"), never rendering the raw phase. */
export type RecoverPhase =
  | 'discovering'
  | 'fetching'
  | 'replaying'
  | 'fencing'
  | 'adopting'
  | 'warming'
  | 'done';

export type RecoverJobState = 'running' | 'done' | 'failed' | 'interrupted';

/** One addressing row a validated kit describes — never the keyring. */
export interface RecoverKitTarget {
  label: string;
  vaultId: string;
  providerHost: string;
}

/** Result of validating a pasted/dropped kit (`POST /recover/kit`). */
export type RecoverKitResult =
  | { ok: true; createdAt: string; targets: RecoverKitTarget[] }
  | { ok: false; message: string };

/** The "found your vault" facts — the one card the user sees before confirming. */
export interface RecoverFound {
  found: true;
  label: string;
  vaultId: string;
  providerHost: string;
  sizeBytes: number | null;
  asOfMs: number | null;
  restoreCostClass: RestoreCostClass | null;
  lazyAvailable: boolean;
}

/** A typed discovery refusal — each maps to a human line in the screen. */
export interface RecoverDiscoverRefusal {
  found: false;
  reason: 'no_snapshot' | 'incompatible' | 'wrong_key' | 'invalid_kit' | 'unreachable';
  message: string;
}

export type RecoverDiscovery = RecoverFound | RecoverDiscoverRefusal;

/** The size/as-of/cost figures a metered-egress confirm shows. */
export interface RecoverEstimate {
  sizeBytes: number | null;
  asOfMs: number | null;
  restoreCostClass: RestoreCostClass | null;
  lazyAvailable: boolean;
}

/** Result of asking the daemon to start (`POST /recover/start`). */
export type RecoverStartResult =
  | { started: true; jobId: string }
  | { started: false; reason: 'confirm_required'; message: string; estimate: RecoverEstimate }
  | {
      started: false;
      reason: 'not_fresh' | 'in_progress' | 'no_snapshot' | 'incompatible' | 'wrong_key' | 'error';
      message: string;
    };

/** The honest completion report (the fields the landing card reads). Extra
 *  gateway fields ride along untyped — the UI only reads these. */
export interface RecoverReportDTO {
  vaultId: string;
  /** Recovered-as-of (epoch ms) — the "safe as of T" the landing shows. */
  recoveredAsOf: number;
  /** What the quarantine parked on first mount (`outbox`/`connections`/`automations`). */
  quarantine: string[];
  restoreCostClass?: RestoreCostClass;
  previews?: { warmed: boolean; timeToUsableGridMs?: number; reason?: string };
}

/** The persisted job record (`GET /recover/status`) — the reattach point. */
export interface RecoverJobRecordDTO {
  jobId: string;
  state: RecoverJobState;
  phase: RecoverPhase;
  startedAt: number;
  updatedAt: number;
  targetId?: string;
  vaultId?: string;
  error?: string;
  report?: RecoverReportDTO;
}

export interface RecoverStatus {
  fresh: boolean;
  job: RecoverJobRecordDTO | null;
}

/** One event off the progress SSE. */
export type RecoverEvent =
  | { kind: 'phase'; phase: RecoverPhase }
  | { kind: 'report'; report: RecoverReportDTO }
  | { kind: 'error'; error: string }
  | { kind: 'end'; state: RecoverJobState };

/** The three user-facing stages the phases collapse to. */
export type RecoverStage = 'fetching' | 'replaying' | 'warming' | 'done';

/** Fold a machine phase into the user stage the progress view highlights. */
export function recoverStageOf(phase: RecoverPhase): RecoverStage {
  switch (phase) {
    case 'discovering':
    case 'fetching':
      return 'fetching';
    case 'replaying':
    case 'fencing':
    case 'adopting':
      return 'replaying';
    case 'warming':
      return 'warming';
    case 'done':
      return 'done';
  }
}

async function readBody(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function codeOf(body: Record<string, unknown>): string | undefined {
  return typeof body['error'] === 'string' ? (body['error'] as string) : undefined;
}

function messageOf(body: Record<string, unknown>, fallback: string): string {
  const m = body['message'];
  return typeof m === 'string' && m.length > 0 ? m : fallback;
}

function estimateOf(raw: unknown): RecoverEstimate {
  const e = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const cost = e['restoreCostClass'];
  return {
    sizeBytes: typeof e['sizeBytes'] === 'number' ? (e['sizeBytes'] as number) : null,
    asOfMs: typeof e['asOfMs'] === 'number' ? (e['asOfMs'] as number) : null,
    restoreCostClass:
      cost === 'metered-egress' || cost === 'free-egress' ? (cost as RestoreCostClass) : null,
    lazyAvailable: e['lazyAvailable'] === true,
  };
}

/**
 * Validate a recovery kit document (already JSON-parsed by the caller). The
 * request body IS the kit document itself (the route re-parses it); the reply
 * is a SANITIZED summary — the keyring never rides back. A malformed kit comes
 * back `{ok:false, message}` (the gateway's message is already user-safe).
 */
export async function validateRecoveryKit(kitDocument: unknown): Promise<RecoverKitResult> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `${BASE}/kit`, {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify(kitDocument),
  });
  const body = await readBody(res);
  if (res.ok && body['ok'] === true) {
    const rawTargets = Array.isArray(body['targets']) ? (body['targets'] as unknown[]) : [];
    const targets: RecoverKitTarget[] = rawTargets.map((t) => {
      const row = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
      return {
        label: String(row['label'] ?? ''),
        vaultId: String(row['vaultId'] ?? ''),
        providerHost: String(row['providerHost'] ?? ''),
      };
    });
    return { ok: true, createdAt: String(body['createdAt'] ?? ''), targets };
  }
  return { ok: false, message: messageOf(body, 'That file is not a valid recovery kit.') };
}

/**
 * Reach the provider and read the "found your vault" facts. Every failure is a
 * typed refusal, never a throw (except an unreachable gateway): a wrong key
 * (the provider's 401/403 passed through), no backup yet, or a snapshot this
 * build can't read.
 */
export async function discoverRecovery(input: {
  kit: unknown;
  apiKey: string;
}): Promise<RecoverDiscovery> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `${BASE}/discover`, {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({ kit: input.kit, apiKey: input.apiKey }),
  });
  const body = await readBody(res);
  if (res.ok && body['found'] === true) {
    const est = estimateOf(body);
    return {
      found: true,
      label: String(body['label'] ?? ''),
      vaultId: String(body['vaultId'] ?? ''),
      providerHost: String(body['providerHost'] ?? ''),
      ...est,
    };
  }
  const code = codeOf(body);
  if (code === 'no_snapshot') {
    return { found: false, reason: 'no_snapshot', message: messageOf(body, 'no_snapshot') };
  }
  if (code === 'incompatible') {
    return { found: false, reason: 'incompatible', message: messageOf(body, 'incompatible') };
  }
  if (code === 'invalid_kit') {
    return { found: false, reason: 'invalid_kit', message: messageOf(body, 'invalid_kit') };
  }
  if ((res.status === 401 || res.status === 403) && code !== 'admin_only') {
    return { found: false, reason: 'wrong_key', message: messageOf(body, 'wrong_key') };
  }
  return {
    found: false,
    reason: 'unreachable',
    message: messageOf(body, `Couldn't reach your provider (HTTP ${res.status}).`),
  };
}

/**
 * Ask the daemon to start the restore. `confirmed:true` is passed ONLY after
 * the user clears the metered-egress price gate. A metered vault without it
 * comes back `confirm_required` carrying the estimate to show.
 */
export async function startRecovery(input: {
  kit: unknown;
  apiKey: string;
  confirmed?: boolean;
}): Promise<RecoverStartResult> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `${BASE}/start`, {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({
      kit: input.kit,
      apiKey: input.apiKey,
      ...(input.confirmed ? { confirmed: true } : {}),
    }),
  });
  const body = await readBody(res);
  if (res.status === 202 && typeof body['jobId'] === 'string') {
    return { started: true, jobId: body['jobId'] as string };
  }
  const code = codeOf(body);
  if (code === 'confirm_required') {
    return {
      started: false,
      reason: 'confirm_required',
      message: messageOf(body, 'confirm_required'),
      estimate: estimateOf(body['estimate']),
    };
  }
  if (code === 'not_fresh') {
    return { started: false, reason: 'not_fresh', message: messageOf(body, 'not_fresh') };
  }
  if (code === 'recover_in_progress') {
    return { started: false, reason: 'in_progress', message: messageOf(body, 'in_progress') };
  }
  if (code === 'no_snapshot') {
    return { started: false, reason: 'no_snapshot', message: messageOf(body, 'no_snapshot') };
  }
  if (code === 'incompatible') {
    return { started: false, reason: 'incompatible', message: messageOf(body, 'incompatible') };
  }
  if ((res.status === 401 || res.status === 403) && code !== 'admin_only') {
    return { started: false, reason: 'wrong_key', message: messageOf(body, 'wrong_key') };
  }
  return {
    started: false,
    reason: 'error',
    message: messageOf(body, `Couldn't start recovery (HTTP ${res.status}).`),
  };
}

/** The entry check + reattach point — is the gateway fresh, and is a job live? */
export async function getRecoverStatus(): Promise<RecoverStatus> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `${BASE}/status`, {
    method: 'GET',
    headers: authHeaders(token),
  });
  const body = await readBody(res);
  const job = body['job'];
  return {
    fresh: body['fresh'] === true,
    job: job && typeof job === 'object' ? (job as RecoverJobRecordDTO) : null,
  };
}

function parseRecoverFrame(event: string, data: string): RecoverEvent | undefined {
  let parsed: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(data) as unknown;
    if (raw && typeof raw === 'object') parsed = raw as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (event === 'phase' && typeof parsed['phase'] === 'string') {
    return { kind: 'phase', phase: parsed['phase'] as RecoverPhase };
  }
  if (event === 'report') {
    return { kind: 'report', report: parsed as unknown as RecoverReportDTO };
  }
  if (event === 'error') {
    return { kind: 'error', error: String(parsed['error'] ?? 'recovery failed') };
  }
  if (event === 'end' && typeof parsed['state'] === 'string') {
    return { kind: 'end', state: parsed['state'] as RecoverJobState };
  }
  return undefined;
}

/**
 * Subscribe to a recovery job's progress SSE (`GET /recover/events?job=<id>`).
 * The gateway replays every event so far, then streams live until the terminal
 * `event: end` closes it (or the caller aborts). `onEvent` fires per parsed
 * frame; the promise resolves on stream close. An abort resolves quietly; a
 * transport failure rejects so the caller can retry.
 */
export async function streamRecoverEvents(
  jobId: string,
  onEvent: (ev: RecoverEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const { baseUrl, token } = await auth();
  try {
    const res = await doFetch(baseUrl, `${BASE}/events?job=${encodeURIComponent(jobId)}`, {
      method: 'GET',
      headers: authHeaders(token),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`recovery progress stream failed (HTTP ${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = frameBoundary(buf);
        if (!boundary) break;
        const raw = buf.slice(0, boundary.index);
        buf = buf.slice(boundary.index + boundary.length);
        const frame = decodeFrame(raw);
        if (!frame) continue;
        const ev = parseRecoverFrame(frame.event, frame.data);
        if (ev) onEvent(ev);
      }
    }
  } catch (err) {
    if (signal.aborted) return;
    throw err;
  }
}
