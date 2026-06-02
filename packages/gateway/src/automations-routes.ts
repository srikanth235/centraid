// HTTP surface for automation runtime ops (issue #141).
//
// The desktop used to read automation manifests off the local
// materialized `main` and read/write run ledgers + analytics from local
// SQLite directly — so these operations threw for a remote gateway.
// These routes move them onto HTTP so the desktop is a thin client for
// local AND remote gateways alike. Mounted via `serve()`'s
// `extraHandlers`, after the bearer check.
//
// Refs and run ids carry `/` and `:`, so they ride query params rather
// than path segments to keep parsing trivial:
//
//   GET  /centraid/_automations                       list → {rows, errors}
//   GET  /centraid/_automations/read?ref=             one automation → {row}
//   POST /centraid/_automations/run-now?ref=          fire now → {runId}
//   GET  /centraid/_automations/runs?ref=&limit=      run feed → {runs}
//   GET  /centraid/_automations/run?runId=            one run → {run}
//   GET  /centraid/_automations/run/nodes?runId=      node timeline → {nodes}
//   POST /centraid/_automations/run/pin?runId=        body {pinned} → {ok}
//   GET  /centraid/_insights/summary?windowDays=      insights payload
//
// Code (manifests) resolves from the git-store materialized `main`
// (`<active-main>/apps`); data (run ledgers, analytics) from the
// gateway's stable `appsDir`. Run-now executes on THIS host with the
// gateway's own runner config — the desktop's provider key is not used
// for a remote fire.

import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AgentRunsStore,
  AnalyticsStore,
  InsightsStore,
  makeRuntimeDbProvider,
  type AgentRunNodeRow,
  type AgentRunRow,
  type AutomationTriggerKind,
  type AutomationTriggerOrigin,
  type RunStreamEvent,
  type RunSummary,
} from '@centraid/app-engine';
import {
  listAutomations,
  parseAutomationRef,
  readAppOwnedAutomation,
} from '@centraid/conversation-engine';
import type { WorktreeStore } from '@centraid/worktree-store';
import { readJson, sendError, sendJson } from './route-helpers.js';

export interface AutomationsRouteOptions {
  /** Git store — code (manifests) resolve from `<getActiveMainLink()>/apps`. */
  store: WorktreeStore;
  /** Stable per-app data dir (run ledgers + analytics live here). */
  dataAppsDir: string;
  /** Central analytics store (the gateway already owns one). */
  analytics: AnalyticsStore;
  /** Insights aggregator over the same analytics DB. */
  insights: InsightsStore;
  /**
   * Fire an automation now (fire-and-forget). Injected so `serve()` wires
   * `runAutomationLocal` with the gateway's dirs + runner, and tests can
   * stub it. The runId is minted by the route and passed in.
   */
  runAutomation: (input: { automationRef: string; runId: string }) => void;
  /**
   * Subscribe to a run's live `RunStreamEvent`s (issue #158). Wired to the
   * gateway's `RunEventBus`. Returns an unsubscribe. Omitted in hosts that
   * don't stream — the SSE endpoint then replays the ledger and closes.
   */
  subscribeRunEvents?: (runId: string, listener: (ev: RunStreamEvent) => void) => () => void;
}

/** Parse a stored `*_json` ledger column back to a value; raw string on failure. */
function safeParseJson(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return json;
  }
}

/**
 * Reconstruct a durable ledger node as live-stream events for SSE replay: a
 * `node.start`, plus a `node.end` when the node has finished (in-flight nodes
 * — `endedAt` NULL — replay as start-only and finish live off the bus).
 */
function replayNodeEvents(node: AgentRunNodeRow): RunStreamEvent[] {
  const start: RunStreamEvent = {
    type: 'node.start',
    ordinal: node.ordinal,
    ...(node.batchId !== undefined ? { batchId: node.batchId } : {}),
    kind: node.kind,
    ...(node.name !== undefined ? { name: node.name } : {}),
    ...(node.argsJson !== undefined ? { args: safeParseJson(node.argsJson) } : {}),
  };
  if (node.endedAt === undefined) return [start];
  const end: RunStreamEvent = {
    type: 'node.end',
    ordinal: node.ordinal,
    ok: node.ok,
    ...(node.outputJson !== undefined ? { result: safeParseJson(node.outputJson) } : {}),
    ...(node.error !== undefined ? { error: node.error } : {}),
    durationMs: node.durationMs ?? 0,
  };
  return [start, end];
}

/** Map a central run summary into the `AgentRunRow` feed shape. */
function summaryToRunRow(s: RunSummary): AgentRunRow {
  return {
    runId: s.runId,
    kind: s.kind,
    ...(s.automationRef !== undefined ? { automationId: s.automationRef } : {}),
    triggerKind: s.trigger as AutomationTriggerKind,
    ...(s.triggerOrigin !== undefined
      ? { triggerOrigin: s.triggerOrigin as AutomationTriggerOrigin }
      : {}),
    ...(s.appId !== undefined ? { appId: s.appId } : {}),
    ...(s.note !== undefined ? { note: s.note } : {}),
    ...(s.retryOf !== undefined ? { retryOf: s.retryOf } : {}),
    startedAt: s.startedAt,
    ...(s.endedAt !== undefined ? { endedAt: s.endedAt } : {}),
    ok: s.ok,
    ...(s.error !== undefined ? { error: s.error } : {}),
    ...(s.summary !== undefined ? { summary: s.summary } : {}),
    pinned: s.pinned ?? false,
    ...(s.totalInputTokens !== undefined ? { totalInputTokens: s.totalInputTokens } : {}),
    ...(s.totalOutputTokens !== undefined ? { totalOutputTokens: s.totalOutputTokens } : {}),
    ...(s.totalCacheReadTokens !== undefined
      ? { totalCacheReadTokens: s.totalCacheReadTokens }
      : {}),
    ...(s.totalCacheWriteTokens !== undefined
      ? { totalCacheWriteTokens: s.totalCacheWriteTokens }
      : {}),
    ...(s.totalCostUsd !== undefined ? { totalCostUsd: s.totalCostUsd } : {}),
    ...(s.stepCount !== undefined ? { stepCount: s.stepCount } : {}),
    ...(s.toolCount !== undefined ? { toolCount: s.toolCount } : {}),
  };
}

/**
 * Build the automation/insights route handler. Returns a function
 * suitable for `startRuntimeHttpServer`'s `extraHandlers`: resolves
 * `true` when it owned the request.
 */
export function makeAutomationsRouteHandler(
  opts: AutomationsRouteOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const codeAppsDir = (): string => path.join(opts.store.getActiveMainLink(), 'apps');

  // Run-ledger store for one run id — every run's full ledger is its
  // app's `runtime.sqlite` under the stable data dir. Automation run ids
  // are `<appId>/<id>:...` (app id inline); a chat run id is a bare UUID,
  // so its owning app comes from the central run summary.
  const runsStoreForRunId = (runId: string): AgentRunsStore | undefined => {
    const slash = runId.indexOf('/');
    const appId = slash > 0 ? runId.slice(0, slash) : opts.analytics.getSummary(runId)?.appId;
    if (!appId) return undefined;
    const dbPath = path.join(opts.dataAppsDir, appId, 'runtime.sqlite');
    // No ledger file means the app/run is unknown here — return undefined
    // rather than letting sqlite throw on a missing parent dir.
    if (!existsSync(dbPath)) return undefined;
    return new AgentRunsStore(makeRuntimeDbProvider(dbPath));
  };

  // SSE: stream one run end-to-end (issue #158, ledger-tail hybrid). Subscribe
  // to the bus first (so events during replay aren't lost), replay the durable
  // ledger snapshot, then drain buffered + live events until `run.end`.
  const streamRunEvents = (req: IncomingMessage, res: ServerResponse, runId: string): boolean => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`: run ${runId}\n\n`);
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
      if (!res.writableEnded) res.end();
    };
    req.on('close', cleanup);
    res.on('error', cleanup);

    const write = (ev: RunStreamEvent): void => {
      if (res.writableEnded) return;
      res.write(`event: ${ev.type}\n`);
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    };

    // Buffer live events that land during replay; drain once the snapshot is
    // written. The client dedupes by ordinal, so a replay/live overlap on the
    // same node is harmless.
    const queue: RunStreamEvent[] = [];
    let replayed = false;
    const drain = (): void => {
      while (queue.length > 0) {
        const ev = queue.shift()!;
        write(ev);
        if (ev.type === 'run.end') {
          cleanup();
          return;
        }
      }
    };
    unsub =
      opts.subscribeRunEvents?.(runId, (ev) => {
        queue.push(ev);
        if (replayed) drain();
      }) ?? ((): void => undefined);

    const store = runsStoreForRunId(runId);
    const run = store?.getRun(runId);
    write({ type: 'run.start', runId });
    const nodes = store ? store.listNodes(runId) : [];
    for (const node of nodes) for (const ev of replayNodeEvents(node)) write(ev);

    // Run already finished (background fire / late join) — emit terminal + close.
    if (run && run.endedAt !== undefined) {
      write({
        type: 'run.end',
        ok: run.ok,
        ...(run.error !== undefined ? { error: run.error } : {}),
      });
      cleanup();
      return true;
    }
    // No live transport wired and the run is still open: replay-only, then
    // close so the client can fall back to polling rather than hang.
    if (!opts.subscribeRunEvents) {
      cleanup();
      return true;
    }

    replayed = true;
    drain();
    return true;
  };

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname } = url;
    const isAutomations = pathname.startsWith('/centraid/_automations');
    const isInsights = pathname === '/centraid/_insights/summary';
    if (!isAutomations && !isInsights) return false;
    const method = (req.method ?? 'GET').toUpperCase();

    try {
      if (isInsights && method === 'GET') {
        const windowDays = Number(url.searchParams.get('windowDays'));
        return sendJson(
          res,
          200,
          opts.insights.summary(
            Number.isFinite(windowDays) && windowDays > 0 ? { windowDays } : {},
          ),
        );
      }

      const sub = pathname.slice('/centraid/_automations'.length).replace(/^\/+/, '');

      if (sub === '' && method === 'GET') {
        return sendJson(res, 200, await listAutomations(codeAppsDir()));
      }

      if (sub === 'read' && method === 'GET') {
        const ref = parseAutomationRef(url.searchParams.get('ref') ?? '');
        if (!ref) return sendJson(res, 200, { row: null });
        const row = await readAppOwnedAutomation(codeAppsDir(), ref.appId, ref.automationId).catch(
          () => undefined,
        );
        return sendJson(res, 200, { row: row ?? null });
      }

      if (sub === 'run-now' && method === 'POST') {
        const ref = url.searchParams.get('ref') ?? '';
        if (!parseAutomationRef(ref)) {
          return sendJson(res, 400, { error: 'bad_request', message: 'run-now needs ?ref=' });
        }
        const runId = `${ref}:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
        opts.runAutomation({ automationRef: ref, runId });
        return sendJson(res, 202, { runId });
      }

      if (sub === 'runs' && method === 'GET') {
        const ref = url.searchParams.get('ref');
        const limit = Number(url.searchParams.get('limit'));
        const summaries = opts.analytics.listSummaries({
          ...(ref ? { automationRef: ref } : {}),
          limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
        });
        return sendJson(res, 200, {
          runs: summaries.filter((s) => s.kind === 'automation').map(summaryToRunRow),
        });
      }

      if (sub === 'run' && method === 'GET') {
        const runId = url.searchParams.get('runId') ?? '';
        const store = runsStoreForRunId(runId);
        return sendJson(res, 200, { run: store?.getRun(runId) ?? null });
      }

      if (sub === 'run/nodes' && method === 'GET') {
        const runId = url.searchParams.get('runId') ?? '';
        const store = runsStoreForRunId(runId);
        return sendJson(res, 200, { nodes: store ? store.listNodes(runId) : [] });
      }

      if (sub === 'run/events' && method === 'GET') {
        const runId = url.searchParams.get('runId') ?? '';
        if (!runId) {
          return sendJson(res, 400, { error: 'bad_request', message: 'run/events needs ?runId=' });
        }
        return streamRunEvents(req, res, runId);
      }

      if (sub === 'run/pin' && method === 'POST') {
        const runId = url.searchParams.get('runId') ?? '';
        const body = await readJson(req);
        const pinned = body.pinned === true;
        runsStoreForRunId(runId)?.setPinned(runId, pinned);
        opts.analytics.setPinned(runId, pinned);
        return sendJson(res, 200, { ok: true });
      }

      return false;
    } catch (err) {
      return sendError(res, err);
    }
  };
}
