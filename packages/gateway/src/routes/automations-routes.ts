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
  ConversationStore,
  AnalyticsStore,
  InsightsStore,
  makeRuntimeDbProvider,
  type Item,
  type Turn,
  type AutomationTriggerKind,
  type AutomationTriggerOrigin,
  type RunKind,
  type RunStreamEvent,
  type RunSummary,
} from '@centraid/app-engine';
import * as automation from '@centraid/automation';
import type { WorktreeStore } from '../worktree-store/index.js';
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
   * `runAutomation` with the gateway's dirs + runner, and tests can
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
 * The run-record JSON the desktop's run feed / detail consumes
 * (`CentraidAutomationRunRecord`). Under issue #190 the spine is
 * conversation/turn/item; `kind` / `automationId` (the ref) source from the
 * owning conversation (via the run summary), `inputJson` from the turn's
 * `message_in` item — so this wire shape stays stable for the renderer.
 */
interface RunRecordJson {
  runId: string;
  kind: RunKind;
  automationId?: string;
  triggerKind: AutomationTriggerKind;
  triggerOrigin?: AutomationTriggerOrigin;
  parentRunId?: string;
  inputJson?: string;
  startedAt: number;
  endedAt?: number;
  ok: boolean;
  error?: string;
  summary?: string;
  outputJson?: string;
  pinned: boolean;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheReadTokens?: number;
  totalCacheWriteTokens?: number;
  totalCostUsd?: number;
  stepCount?: number;
  toolCount?: number;
}

/**
 * Reconstruct a durable ledger item as live-stream events for SSE replay: a
 * `node.start`, plus a `node.end` when the item has finished (in-flight items
 * — `endedAt` NULL — replay as start-only and finish live off the bus). The
 * inbound `message_in` item is not a trace node and is filtered by the caller.
 */
function replayNodeEvents(item: Item): RunStreamEvent[] {
  const start: RunStreamEvent = {
    type: 'node.start',
    ordinal: item.ordinal,
    ...(item.batchId !== undefined ? { batchId: item.batchId } : {}),
    kind: item.kind,
    ...(item.name !== undefined ? { name: item.name } : {}),
    ...(item.argsJson !== undefined ? { args: safeParseJson(item.argsJson) } : {}),
  };
  if (item.endedAt === undefined) return [start];
  const end: RunStreamEvent = {
    type: 'node.end',
    ordinal: item.ordinal,
    ok: item.ok,
    ...(item.outputJson !== undefined ? { result: safeParseJson(item.outputJson) } : {}),
    ...(item.error !== undefined ? { error: item.error } : {}),
    durationMs: item.durationMs ?? 0,
  };
  return [start, end];
}

/** Map a central run summary into the run-feed record shape. */
function summaryToRunRow(s: RunSummary): RunRecordJson {
  return {
    runId: s.runId,
    kind: s.kind,
    ...(s.automationRef !== undefined ? { automationId: s.automationRef } : {}),
    triggerKind: s.trigger as AutomationTriggerKind,
    ...(s.triggerOrigin !== undefined
      ? { triggerOrigin: s.triggerOrigin as AutomationTriggerOrigin }
      : {}),
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
 * The single-run detail record: the `turns` row enriched with `kind` /
 * `automationId` from the run summary and `inputJson` from the turn's
 * `message_in` item — the stable wire shape the renderer's run viewer reads.
 */
function turnToRunRecord(
  turn: Turn,
  summary: RunSummary | undefined,
  inputJson: string | undefined,
  automationRef: string | undefined,
): RunRecordJson {
  // Prefer the analytics summary's ref; fall back to the owning execution
  // conversation's `automation_id` (the conversation id is no longer the ref —
  // each fire is its own conversation).
  const ref = summary?.automationRef ?? automationRef;
  return {
    runId: turn.turnId,
    kind: summary?.kind ?? 'automation',
    ...(ref !== undefined ? { automationId: ref } : {}),
    triggerKind: turn.triggerKind,
    ...(turn.triggerOrigin !== undefined ? { triggerOrigin: turn.triggerOrigin } : {}),
    ...(turn.parentTurnId !== undefined ? { parentRunId: turn.parentTurnId } : {}),
    ...(inputJson !== undefined ? { inputJson } : {}),
    startedAt: turn.startedAt,
    ...(turn.endedAt !== undefined ? { endedAt: turn.endedAt } : {}),
    ok: turn.ok,
    ...(turn.error !== undefined ? { error: turn.error } : {}),
    ...(turn.summary !== undefined ? { summary: turn.summary } : {}),
    ...(turn.outputJson !== undefined ? { outputJson: turn.outputJson } : {}),
    pinned: turn.pinned,
    ...(turn.totalInputTokens !== undefined ? { totalInputTokens: turn.totalInputTokens } : {}),
    ...(turn.totalOutputTokens !== undefined ? { totalOutputTokens: turn.totalOutputTokens } : {}),
    ...(turn.totalCacheReadTokens !== undefined
      ? { totalCacheReadTokens: turn.totalCacheReadTokens }
      : {}),
    ...(turn.totalCacheWriteTokens !== undefined
      ? { totalCacheWriteTokens: turn.totalCacheWriteTokens }
      : {}),
    ...(turn.totalCostUsd !== undefined ? { totalCostUsd: turn.totalCostUsd } : {}),
    ...(turn.stepCount !== undefined ? { stepCount: turn.stepCount } : {}),
    ...(turn.toolCount !== undefined ? { toolCount: turn.toolCount } : {}),
  };
}

/** Map an `items` row into the legacy run-node wire shape the renderer reads. */
function itemToNode(item: Item): Record<string, unknown> {
  return {
    nodeId: item.itemId,
    runId: item.turnId,
    ordinal: item.ordinal,
    ...(item.batchId !== undefined ? { batchId: item.batchId } : {}),
    kind: item.kind,
    ...(item.name !== undefined ? { name: item.name } : {}),
    ...(item.argsJson !== undefined ? { argsJson: item.argsJson } : {}),
    ...(item.outputJson !== undefined ? { outputJson: item.outputJson } : {}),
    ok: item.ok,
    ...(item.error !== undefined ? { error: item.error } : {}),
    startedAt: item.startedAt,
    ...(item.endedAt !== undefined ? { endedAt: item.endedAt } : {}),
    ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
    ...(item.inputTokens !== undefined ? { inputTokens: item.inputTokens } : {}),
    ...(item.outputTokens !== undefined ? { outputTokens: item.outputTokens } : {}),
    ...(item.cacheReadTokens !== undefined ? { cacheReadTokens: item.cacheReadTokens } : {}),
    ...(item.cacheWriteTokens !== undefined ? { cacheWriteTokens: item.cacheWriteTokens } : {}),
    ...(item.model !== undefined ? { model: item.model } : {}),
    ...(item.provider !== undefined ? { provider: item.provider } : {}),
    ...(item.costUsd !== undefined ? { costUsd: item.costUsd } : {}),
    ...(item.childTurnId !== undefined ? { childRunId: item.childTurnId } : {}),
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
  const runsStoreForRunId = (runId: string): ConversationStore | undefined => {
    const slash = runId.indexOf('/');
    const appId = slash > 0 ? runId.slice(0, slash) : opts.analytics.getSummary(runId)?.appId;
    if (!appId) return undefined;
    const dbPath = path.join(opts.dataAppsDir, appId, 'runtime.sqlite');
    // No ledger file means the app/run is unknown here — return undefined
    // rather than letting sqlite throw on a missing parent dir.
    if (!existsSync(dbPath)) return undefined;
    return new ConversationStore(makeRuntimeDbProvider(dbPath));
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
    const run = store?.getTurn(runId);
    write({ type: 'run.start', runId });
    const items = store ? store.listItems(runId) : [];
    for (const item of items) {
      if (item.kind === 'message_in') continue;
      for (const ev of replayNodeEvents(item)) write(ev);
    }

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
        return sendJson(res, 200, await automation.list(codeAppsDir()));
      }

      if (sub === 'read' && method === 'GET') {
        const ref = automation.parseRef(url.searchParams.get('ref') ?? '');
        if (!ref) return sendJson(res, 200, { row: null });
        const row = await automation
          .readAppOwned(codeAppsDir(), ref.appId, ref.automationId)
          .catch(() => undefined);
        return sendJson(res, 200, { row: row ?? null });
      }

      if (sub === 'run-now' && method === 'POST') {
        const ref = url.searchParams.get('ref') ?? '';
        if (!automation.parseRef(ref)) {
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
        const turn = store?.getTurn(runId);
        if (!store || !turn) return sendJson(res, 200, { run: null });
        const record = turnToRunRecord(
          turn,
          opts.analytics.getSummary(runId),
          store.messageInText(runId),
          store.getConversation(turn.conversationId)?.automationId,
        );
        return sendJson(res, 200, { run: record });
      }

      if (sub === 'run/nodes' && method === 'GET') {
        const runId = url.searchParams.get('runId') ?? '';
        const store = runsStoreForRunId(runId);
        const nodes = store
          ? store
              .listItems(runId)
              .filter((i) => i.kind !== 'message_in')
              .map(itemToNode)
          : [];
        return sendJson(res, 200, { nodes });
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
        runsStoreForRunId(runId)?.setTurnPinned(runId, pinned);
        opts.analytics.setPinned(runId, pinned);
        return sendJson(res, 200, { ok: true });
      }

      return false;
    } catch (err) {
      return sendError(res, err);
    }
  };
}
