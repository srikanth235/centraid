// governance: allow-repo-hygiene file-size-limit (#387) single dispatch surface for the automation read/run/runs/SSE wire (one switch over one HTTP contract); splitting scatters the route table without a seam
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
//   POST /centraid/_automations/run-now?ref=          fire now → {turnId}
//   GET  /centraid/_automations/turns?ref=&limit=     turn feed → {turns}
//   GET  /centraid/_automations/turn?turnId=          one turn → {turn}
//   POST /centraid/_automations/turn?ref=             interactive turn → TurnStreamEvent SSE
//   GET  /centraid/_automations/turn/items?turnId=    item timeline → {items}
//   POST /centraid/_automations/turn/pin?turnId=      body {pinned} → {ok}
//   GET  /centraid/_insights/summary?windowDays=      insights payload
//
// Code (manifests) resolves from the git-store materialized `main`
// (`<active-main>/apps`); data (run ledgers, analytics) from the
// gateway's stable `appsDir`. Run-now executes on THIS host with the
// gateway's own runner config — the desktop's provider key is not used
// for a remote fire.

import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ConversationStore,
  AnalyticsStore,
  InsightsStore,
  makeJournalDbProvider,
  type Item,
  type Turn,
  type AutomationTurnStreamEvent,
  type TurnStreamEvent,
} from '@centraid/app-engine';
import * as automation from '@centraid/automation';
import type { WorktreeStore } from '../worktree-store/index.js';
import { readJson, sendError, sendJson } from './route-helpers.js';
import { SseSubscriberCap } from './sse-cap.js';

/**
 * The production subscriber cap for `/centraid/_automations/turn/events` —
 * one gateway process serves one of these (`buildGateway` calls
 * `makeAutomationsRouteHandler` with no override), so this instance's live
 * count IS the real count (issue #351).
 */
const defaultSubscriberCap = new SseSubscriberCap();

/** Live subscriber count on the automation run-events SSE stream. */
export function turnEventsSubscriberCount(): number {
  return defaultSubscriberCap.current();
}

export interface AutomationsRouteOptions {
  /** Git store — code (manifests) resolve from `<getActiveMainLink()>/apps`. */
  store: WorktreeStore;
  /** The vault's `journal.db` — every run's full ledger lives here (#280). */
  journalDbFile: string;
  /** The vault's run-summary rollup (same file as the ledger, #280). */
  analytics: AnalyticsStore;
  /** Insights aggregator over the same rollup. */
  insights: InsightsStore;
  /**
   * Fire an automation now (fire-and-forget). Injected so `serve()` wires
   * `runAutomation` with the gateway's dirs + runner, and tests can
   * stub it. The turnId is minted by the route and passed in.
   */
  runAutomation: (input: { automationRef: string; turnId: string }) => void;
  /**
   * Subscribe to a turn's live native events. Wired to the gateway event bus.
   * Returns an unsubscribe. Omitted in hosts that
   * don't stream — the SSE endpoint then replays the ledger and closes.
   */
  subscribeTurnEvents?: (
    turnId: string,
    listener: (ev: AutomationTurnStreamEvent, serialized: string) => void,
  ) => () => void;
  /**
   * Drive a real interactive automation turn. The route owns the standard
   * `TurnStreamEvent` SSE transport; the injected lifecycle owns ledger,
   * scoped runner dispatch, and automation-bus fanout.
   */
  runInteractiveTurn?: (input: {
    row: automation.Row;
    turnId: string;
    message: string;
    abortSignal: AbortSignal;
    onEvent: (event: TurnStreamEvent) => void;
  }) => Promise<void>;
  /** Overridable for tests; production callers take the shared default. */
  subscriberCap?: SseSubscriberCap;
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
 * Native automation turn JSON enriched with its stable conversation identity.
 */
interface AutomationTurnJson extends Turn {
  automationId?: string;
  /** The automation's last-known display name — see `RunSummary.automationName`. */
  automationName?: string;
}

/**
 * Reconstruct a durable ledger item as live-stream events for SSE replay: an
 * `item.start`, plus an `item.end` when the item has finished (in-flight items
 * — `endedAt` NULL — replay as start-only and finish live off the bus). The
 * inbound `message_in` item is not a trace node and is filtered by the caller.
 */
function replayItemEvents(item: Item): AutomationTurnStreamEvent[] {
  const start: AutomationTurnStreamEvent = {
    type: 'item.start',
    itemId: item.itemId,
    ordinal: item.ordinal,
    ...(item.callId !== undefined ? { callId: item.callId } : {}),
    ...(item.batchId !== undefined ? { batchId: item.batchId } : {}),
    kind: item.kind,
    ...(item.name !== undefined ? { name: item.name } : {}),
    ...(item.argsJson !== undefined ? { args: safeParseJson(item.argsJson) } : {}),
    ...(item.rawJson !== undefined ? { rawJson: item.rawJson } : {}),
  };
  if (item.endedAt === undefined) return [start];
  const end: AutomationTurnStreamEvent = {
    type: 'item.end',
    itemId: item.itemId,
    ordinal: item.ordinal,
    ...(item.callId !== undefined ? { callId: item.callId } : {}),
    ok: item.ok,
    ...(item.outputJson !== undefined ? { result: safeParseJson(item.outputJson) } : {}),
    ...(item.error !== undefined ? { error: item.error } : {}),
    durationMs: item.durationMs ?? 0,
    ...(item.rawJson !== undefined ? { rawJson: item.rawJson } : {}),
  };
  return [start, end];
}

/** Enrich the native row with its automation conversation identity. */
function turnToAutomationTurn(
  turn: Turn,
  automationRef: string | undefined,
  conversationTitle: string | undefined,
): AutomationTurnJson {
  return {
    ...turn,
    ...(automationRef !== undefined ? { automationId: automationRef } : {}),
    ...(conversationTitle ? { automationName: conversationTitle } : {}),
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
  const subscriberCap = opts.subscriberCap ?? defaultSubscriberCap;

  // Run-ledger store — every run's full ledger is the vault's single
  // `journal.db` (#280), so run-id → file resolution is gone. A ledger
  // file that doesn't exist yet just means no run ever landed here.
  const turnsStore = new ConversationStore(makeJournalDbProvider(opts.journalDbFile));
  const turnsStoreForTurnId = (_turnId: string): ConversationStore | undefined => {
    if (!existsSync(opts.journalDbFile)) return undefined;
    return turnsStore;
  };

  // SSE: stream one run end-to-end (issue #158, ledger-tail hybrid). Subscribe
  // to the bus first (so events during replay aren't lost), replay the durable
  // ledger snapshot, then drain buffered + live events until `turn.end`.
  const streamTurnEvents = (req: IncomingMessage, res: ServerResponse, turnId: string): boolean => {
    const releaseSlot = subscriberCap.admit(res);
    if (!releaseSlot) return true; // 503 + Retry-After already written

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`: turn ${turnId}\n\n`);
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

    const write = (ev: AutomationTurnStreamEvent, serialized = JSON.stringify(ev)): void => {
      if (res.writableEnded) return;
      res.write(`event: ${ev.type}\n`);
      res.write(`data: ${serialized}\n\n`);
    };

    // Buffer live events that land during replay; drain once the snapshot is
    // written. The client dedupes by ordinal, so a replay/live overlap on the
    // same node is harmless.
    const queue: Array<readonly [AutomationTurnStreamEvent, string]> = [];
    let replayed = false;
    const drain = (): void => {
      while (queue.length > 0) {
        const [ev, serialized] = queue.shift()!;
        write(ev, serialized);
        if (ev.type === 'turn.end') {
          cleanup();
          return;
        }
      }
    };
    unsub =
      opts.subscribeTurnEvents?.(turnId, (ev, serialized) => {
        queue.push([ev, serialized]);
        if (replayed) drain();
      }) ?? ((): void => undefined);

    const store = turnsStoreForTurnId(turnId);
    const turn = store?.getTurn(turnId);
    write({ type: 'turn.start', turnId });
    const items = store ? store.listItems(turnId) : [];
    for (const item of items) {
      if (item.kind === 'message_in') continue;
      for (const ev of replayItemEvents(item)) write(ev);
    }

    // Run already finished (background fire / late join) — emit terminal + close.
    if (turn && turn.endedAt !== undefined) {
      write({
        type: 'turn.end',
        turnId,
        ok: turn.ok,
        ...(turn.error !== undefined ? { error: turn.error } : {}),
      });
      cleanup();
      return true;
    }
    // No live transport wired and the run is still open: replay-only, then
    // close so the client can fall back to polling rather than hang.
    if (!opts.subscribeTurnEvents) {
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

      // The compiler's output made legible: the instructions-first editor
      // owns intent, but the deterministic plan the headless compiler writes
      // (`automation.json` + `handler.js`) is what actually runs. Surfacing it
      // read-only lets the owner see exactly what their prose became.
      if (sub === 'source' && method === 'GET') {
        const ref = automation.parseRef(url.searchParams.get('ref') ?? '');
        if (!ref)
          return sendJson(res, 400, { error: 'bad_request', message: 'source needs ?ref=' });
        const dir = path.join(codeAppsDir(), ref.appId, 'automations', ref.automationId);
        const read = (file: string): Promise<string | null> =>
          readFile(path.join(dir, file), 'utf8').catch(() => null);
        const [manifest, handler] = await Promise.all([
          read(automation.MANIFEST_FILE),
          read(automation.HANDLER_FILE),
        ]);
        return sendJson(res, 200, { manifest, handler });
      }

      if (sub === 'run-now' && method === 'POST') {
        const ref = url.searchParams.get('ref') ?? '';
        if (!automation.parseRef(ref)) {
          return sendJson(res, 400, { error: 'bad_request', message: 'run-now needs ?ref=' });
        }
        const turnId = `${ref}:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
        opts.runAutomation({ automationRef: ref, turnId });
        return sendJson(res, 202, { turnId });
      }

      if (sub === 'turns' && method === 'GET') {
        const ref = url.searchParams.get('ref');
        const limit = Number(url.searchParams.get('limit'));
        const boundedLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 250) : 50;
        if (!existsSync(opts.journalDbFile)) return sendJson(res, 200, { turns: [] });
        const rows = ref
          ? turnsStore.listAutomationTurns(ref, { limit: boundedLimit })
          : (() => {
              const finished = opts.analytics
                .listSummaries({ limit: boundedLimit })
                .filter((summary) => summary.kind === 'automation')
                .map((summary) => turnsStore.getTurn(summary.runId))
                .filter((turn): turn is Turn => turn !== undefined);
              const seen = new Set(finished.map((turn) => turn.turnId));
              return [
                ...turnsStore
                  .listInFlightAutomationTurns(boundedLimit)
                  .filter((turn) => !seen.has(turn.turnId)),
                ...finished,
              ]
                .sort((a, b) => b.startedAt - a.startedAt)
                .slice(0, boundedLimit);
            })();
        const turns = rows.map((turn) => {
          const conversation = turnsStore.getConversation(turn.conversationId);
          return turnToAutomationTurn(turn, conversation?.automationId, conversation?.title);
        });
        return sendJson(res, 200, { turns });
      }

      if (sub === 'turn' && method === 'GET') {
        const requestedTurnId = url.searchParams.get('turnId') ?? '';
        const ref = url.searchParams.get('ref') ?? '';
        const store = turnsStoreForTurnId(requestedTurnId);
        const turn =
          store?.getTurn(requestedTurnId) ??
          (ref ? store?.listAutomationTurns(ref, { limit: 1 })[0] : undefined);
        if (!store || !turn) return sendJson(res, 200, { turn: null });
        const conversation = store.getConversation(turn.conversationId);
        const record = turnToAutomationTurn(turn, conversation?.automationId, conversation?.title);
        return sendJson(res, 200, {
          turn: record,
          ...(url.searchParams.get('expand') === 'items'
            ? { items: store.listItems(turn.turnId) }
            : {}),
        });
      }

      if (sub === 'turn' && method === 'POST') {
        const parsed = automation.parseRef(url.searchParams.get('ref') ?? '');
        if (!parsed) {
          return sendJson(res, 400, {
            error: 'bad_request',
            message: 'turn needs ?ref=',
          });
        }
        if (!opts.runInteractiveTurn) {
          return sendJson(res, 501, {
            error: 'not_supported',
            message: 'Interactive automation turns are not available on this gateway.',
          });
        }
        const row = await automation.readAppOwned(codeAppsDir(), parsed.appId, parsed.automationId);
        if (!row) {
          return sendJson(res, 404, {
            error: 'not_found',
            message: `Automation "${parsed.appId}/${parsed.automationId}" was not found.`,
          });
        }
        const body = await readJson(req);
        const message = typeof body.message === 'string' ? body.message.trim() : '';
        if (!message) {
          return sendJson(res, 400, {
            error: 'bad_request',
            message: 'turn body needs a non-empty {message}',
          });
        }
        const turnId = `${row.ref}:interactive:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
        const abort = new AbortController();
        const onClose = (): void => abort.abort();
        req.on('close', onClose);
        req.on('error', onClose);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          'X-Centraid-Turn-Id': turnId,
        });
        res.write(`: automation ${row.ref} turn ${turnId}\n\n`);
        const heartbeat = setInterval(() => {
          if (!res.writableEnded) res.write(`: ping\n\n`);
        }, 30_000);
        heartbeat.unref?.();
        const onEvent = (event: TurnStreamEvent): void => {
          if (res.writableEnded) return;
          res.write(`event: ${event.type}\n`);
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        };
        try {
          await opts.runInteractiveTurn({
            row,
            turnId,
            message,
            abortSignal: abort.signal,
            onEvent,
          });
        } catch (error) {
          onEvent({
            type: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          clearInterval(heartbeat);
          req.off('close', onClose);
          req.off('error', onClose);
          if (!res.writableEnded) {
            res.write('event: end\ndata: {}\n\n');
            res.end();
          }
        }
        return true;
      }

      if (sub === 'turn/items' && method === 'GET') {
        const turnId = url.searchParams.get('turnId') ?? '';
        const store = turnsStoreForTurnId(turnId);
        return sendJson(res, 200, { items: store?.listItems(turnId) ?? [] });
      }

      if (sub === 'turn/events' && method === 'GET') {
        const turnId = url.searchParams.get('turnId') ?? '';
        if (!turnId) {
          return sendJson(res, 400, {
            error: 'bad_request',
            message: 'turn/events needs ?turnId=',
          });
        }
        return streamTurnEvents(req, res, turnId);
      }

      if (sub === 'turn/pin' && method === 'POST') {
        const turnId = url.searchParams.get('turnId') ?? '';
        const body = await readJson(req);
        const pinned = body.pinned === true;
        // turns.pinned is the source — the run_summary view reflects it.
        turnsStoreForTurnId(turnId)?.setTurnPinned(turnId, pinned);
        return sendJson(res, 200, { ok: true });
      }

      return false;
    } catch (err) {
      return sendError(res, err);
    }
  };
}
