/*
 * Pre-vault gateway recovery routes (issue #439 R1 wave 4) — the wire surface
 * the fresh-gateway onboarding branch drives (the UI wave builds its screens on
 * this exact contract). Orchestration over the service-layer `recover()` verb
 * and its `discoverRecovery` facts pass, NOT new machinery: kit validation,
 * "found your vault" discovery, the metered-egress price gate, the daemon-owned
 * job, and its progress SSE.
 *
 *   POST /centraid/_gateway/recover/kit       validate a pasted/dropped kit;
 *                                             respond with a SANITIZED summary
 *                                             (targets' label/host/vaultId) —
 *                                             NEVER the keyring
 *   POST /centraid/_gateway/recover/discover  {kit, apiKey} → the found-your-vault
 *                                             card (size/as-of/host/cost) or a
 *                                             typed refusal (incompatible /
 *                                             no-snapshot / bad-key)
 *   POST /centraid/_gateway/recover/start     {kit, apiKey, confirmed?} → start the
 *                                             daemon job. Server-side gates:
 *                                             non-fresh gateway ⇒ 409; metered
 *                                             egress without `confirmed` ⇒ 409
 *                                             (with the estimate); a job already
 *                                             running ⇒ 409. Returns {jobId}
 *   GET  /centraid/_gateway/recover/status    {fresh, job} — the UI's entry check
 *                                             + reattach point
 *   GET  /centraid/_gateway/recover/events?job=<id>  progress SSE: replay all
 *                                             events so far, then live, 30s
 *                                             heartbeat, terminal `event: end`
 *
 * This handler is a TOP-LEVEL pre-vault route (mounted in `serve.ts` between the
 * webhook and composed handlers), NOT one of `composedHandler`'s per-request
 * vault-scoped `extraHandlers`: recovery is a landlord act that stands up the
 * home vault before one is chosen, and its adopt step swaps the vault set under
 * the running daemon — so it must live outside any single vault's ambient scope
 * (the webhook handler is the same-shaped precedent). The app-engine bearer
 * check still runs first (these paths are NOT in `publicPaths`); on top of that
 * the routes are ADMIN-plane only — a per-device HTTP token (issue #376) is
 * refused, because bootstrapping the gateway's own vault is the owner's act.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { AUTHED_DEVICE_HEADER } from '@centraid/app-engine';
import { BackupProviderError, parseRecoveryKit } from '@centraid/backup';
import type { RouteHandler } from '../serve/build-gateway.js';
import { discoverRecovery, type RecoveryDiscovery } from '../backup/recover.js';
import {
  RecoverJobConflictError,
  type RecoverJobEvent,
  type RecoverJobRunner,
} from '../backup/recover-job.js';
import { SseSubscriberCap } from './sse-cap.js';
import { readJson, sendError, sendJson } from './route-helpers.js';

const BASE = '/centraid/_gateway/recover';
const KIT_PATH = `${BASE}/kit`;
const DISCOVER_PATH = `${BASE}/discover`;
const START_PATH = `${BASE}/start`;
const STATUS_PATH = `${BASE}/status`;
const EVENTS_PATH = `${BASE}/events`;

/** The recover progress SSE gets its own concurrent-subscriber cap. */
const defaultSubscriberCap = new SseSubscriberCap();

export interface RecoverRouteDeps {
  job: RecoverJobRunner;
  /** The airtight fresh-gateway signal (`VaultRegistry.isFresh`) the start gate reads. */
  isFresh: () => boolean;
  /** Overridable for tests; production takes the shared default. */
  subscriberCap?: SseSubscriberCap;
}

/** A display host for the "hosted at …" line — the base URL's host, or `local`
 *  for an operator/test `local:<dir>` provider. Never the api-key or a secret. */
function providerHost(provider: string): string {
  if (provider.startsWith('local:')) return 'local';
  try {
    return new URL(provider).host;
  } catch {
    return provider;
  }
}

/** Map a provider/parse failure to a wire response. A bad kit is a 400; a
 *  provider auth/reachability error passes its own status through so the UI can
 *  tell "wrong key" (401/403) from "provider down" (5xx). */
function sendDiscoveryError(res: ServerResponse, err: unknown): true {
  if (err instanceof BackupProviderError) {
    return sendJson(res, err.status, { error: err.code, message: err.message });
  }
  // parseRecoveryKit / selectTarget throw plain Errors on a malformed or
  // multi-vault kit — the caller's input is wrong, so 400.
  return sendJson(res, 400, {
    error: 'invalid_kit',
    message: err instanceof Error ? err.message : String(err),
  });
}

/** The price/size facts a metered-egress confirm (and the found-your-vault card)
 *  needs — the same figures Wave 1's `RestoreEgressEstimate` carries, no
 *  machine vocabulary. */
function estimateOf(discovery: RecoveryDiscovery): Record<string, unknown> {
  return {
    sizeBytes: discovery.fullBytes ?? null,
    asOfMs: discovery.recoveredAsOf ?? null,
    restoreCostClass: discovery.restoreCostClass ?? null,
    lazyAvailable: discovery.lazyAvailable,
  };
}

async function readKitAndKey(
  req: IncomingMessage,
): Promise<{ kitDocument: unknown; apiKey: string; confirmed: boolean }> {
  const body = await readJson(req);
  const apiKey = typeof body['apiKey'] === 'string' ? body['apiKey'] : '';
  return { kitDocument: body['kit'], apiKey, confirmed: body['confirmed'] === true };
}

export function makeRecoverRouteHandler(deps: RecoverRouteDeps): RouteHandler {
  const subscriberCap = deps.subscriberCap ?? defaultSubscriberCap;

  const streamEvents = (req: IncomingMessage, res: ServerResponse, jobId: string): boolean => {
    const record = deps.job.currentRecord();
    if (!record || record.jobId !== jobId) {
      return sendJson(res, 404, {
        error: 'job_not_found',
        message: 'no recovery job with that id — check /recover/status',
      });
    }
    const releaseSlot = subscriberCap.admit(res);
    if (!releaseSlot) return true; // 503 + Retry-After already written

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`: recover ${jobId}\n\n`);
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(`: ping\n\n`);
    }, 30_000);
    heartbeat.unref?.();

    let closed = false;
    let unsub = (): void => undefined;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsub();
      releaseSlot();
      if (!res.writableEnded) res.end();
    };
    req.on('close', cleanup);
    res.on('error', cleanup);

    // Terminal → write the closing `event: end` and tear down.
    const write = (ev: RecoverJobEvent): void => {
      if (res.writableEnded) return;
      if (ev.kind === 'phase') {
        res.write(`event: phase\ndata: ${JSON.stringify({ phase: ev.phase })}\n\n`);
        return;
      }
      if (ev.kind === 'done') res.write(`event: report\ndata: ${JSON.stringify(ev.report)}\n\n`);
      else if (ev.kind === 'failed')
        res.write(`event: error\ndata: ${JSON.stringify({ error: ev.error })}\n\n`);
      const state = ev.kind === 'done' ? 'done' : ev.kind === 'failed' ? 'failed' : 'interrupted';
      res.write(`event: end\ndata: ${JSON.stringify({ state })}\n\n`);
      cleanup();
    };

    // Replay everything so far (a reconnecting/late UI sees the full phase
    // history), then go live. Both are synchronous against the in-process job,
    // so no event can slip between the snapshot and the subscribe.
    const replay = deps.job.snapshot(jobId);
    for (const ev of replay) {
      write(ev);
      if (closed) return true; // history already ended in a terminal event
    }
    unsub = deps.job.subscribe(jobId, write);
    return true;
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    if (!url.pathname.startsWith(`${BASE}/`)) return false;

    // Admin plane only (issue #376): the app-engine bearer check already ran
    // (these paths are not public); a per-device HTTP token carries the authed
    // device header, and standing up the gateway's own vault is the owner's act.
    if (req.headers[AUTHED_DEVICE_HEADER] !== undefined) {
      return sendJson(res, 403, {
        error: 'admin_only',
        message: 'recovery is an owner (admin) act; a paired device cannot start it',
      });
    }

    const method = (req.method ?? 'GET').toUpperCase();

    if (url.pathname === KIT_PATH) {
      if (method !== 'POST') return sendJson(res, 405, methodError('POST'));
      try {
        const kit = parseRecoveryKit(await readJson(req));
        // NEVER echo the keyring — only the addressing summary a UI shows.
        return sendJson(res, 200, {
          ok: true,
          createdAt: kit.createdAt,
          targets: kit.targets.map((t) => ({
            label: t.label,
            vaultId: t.vaultId,
            providerHost: providerHost(t.provider),
          })),
        });
      } catch (err) {
        return sendJson(res, 400, {
          error: 'invalid_kit',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (url.pathname === DISCOVER_PATH) {
      if (method !== 'POST') return sendJson(res, 405, methodError('POST'));
      let discovery: RecoveryDiscovery;
      try {
        const { kitDocument, apiKey } = await readKitAndKey(req);
        discovery = await discoverRecovery({ kitDocument, apiKey });
      } catch (err) {
        return sendDiscoveryError(res, err);
      }
      if (discovery.seq === undefined) {
        return sendJson(res, 404, {
          error: 'no_snapshot',
          message: 'this recovery kit has no backup on the provider yet — nothing to recover',
        });
      }
      if (!discovery.compatible) {
        return sendJson(res, 409, {
          error: 'incompatible',
          message: discovery.incompatibleReason ?? 'update the gateway to read this backup',
        });
      }
      return sendJson(res, 200, {
        found: true,
        label: discovery.target.label,
        vaultId: discovery.target.vaultId,
        providerHost: providerHost(discovery.target.provider),
        compatible: true,
        ...estimateOf(discovery),
      });
    }

    if (url.pathname === START_PATH) {
      if (method !== 'POST') return sendJson(res, 405, methodError('POST'));
      // Freshness first — refuse a gateway that already carries user content
      // WITHOUT even dialing the provider.
      if (!deps.isFresh()) {
        return sendJson(res, 409, {
          error: 'not_fresh',
          message:
            'this gateway already hosts a vault — recovery only runs on a fresh gateway, never ' +
            'over existing content',
        });
      }
      let kitDocument: unknown;
      let apiKey: string;
      let confirmed: boolean;
      let discovery: RecoveryDiscovery;
      try {
        ({ kitDocument, apiKey, confirmed } = await readKitAndKey(req));
        discovery = await discoverRecovery({ kitDocument, apiKey });
      } catch (err) {
        return sendDiscoveryError(res, err);
      }
      if (discovery.seq === undefined) {
        return sendJson(res, 404, {
          error: 'no_snapshot',
          message: 'this recovery kit has no backup on the provider yet — nothing to recover',
        });
      }
      if (!discovery.compatible) {
        return sendJson(res, 409, {
          error: 'incompatible',
          message: discovery.incompatibleReason ?? 'update the gateway to read this backup',
        });
      }
      // The protocol's metered-egress MUST finally getting a call site: a hosted
      // vault whose provider bills egress needs an explicit confirm before the
      // bulk download starts.
      if (discovery.restoreCostClass === 'metered-egress' && !confirmed) {
        return sendJson(res, 409, {
          error: 'confirm_required',
          message:
            'recovering this vault downloads from a metered provider — resend with confirmed: true',
          estimate: estimateOf(discovery),
        });
      }
      try {
        const { jobId } = await deps.job.start({ kitDocument, apiKey });
        return sendJson(res, 202, { jobId });
      } catch (err) {
        if (err instanceof RecoverJobConflictError) {
          return sendJson(res, 409, { error: err.code, message: err.message });
        }
        return sendError(res, err);
      }
    }

    if (url.pathname === STATUS_PATH) {
      if (method !== 'GET') return sendJson(res, 405, methodError('GET'));
      return sendJson(res, 200, { fresh: deps.isFresh(), job: deps.job.currentRecord() });
    }

    if (url.pathname === EVENTS_PATH) {
      if (method !== 'GET') return sendJson(res, 405, methodError('GET'));
      const jobId = url.searchParams.get('job');
      if (!jobId) {
        return sendJson(res, 400, { error: 'bad_request', message: 'missing ?job=<id>' });
      }
      return streamEvents(req, res, jobId);
    }

    return false;
  };
}

function methodError(allowed: string): { error: string; message: string } {
  return { error: 'method_not_allowed', message: `${allowed} only` };
}
