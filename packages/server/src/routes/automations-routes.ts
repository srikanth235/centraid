// governance: allow-repo-hygiene file-size-limit (#387) single dispatch surface for the automation read/turn/item/SSE wire (one switch over one HTTP contract); splitting scatters the route table without a seam
// HTTP surface for automation runtime ops (issue #141).
//
// The desktop used to read automation manifests off the local
// materialized `main` and read/write turn ledgers + analytics from local
// SQLite directly — so these operations threw for a remote gateway.
// These routes move them onto HTTP so the desktop is a thin client for
// local AND remote gateways alike. Mounted via `serve()`'s
// `extraHandlers`, after the bearer check.
//
// Refs and turn ids carry `/` and `:`, so they ride query params rather
// than path segments to keep parsing trivial:
//
//   GET  /centraid/_automations                       list → {rows, errors}
//   GET  /centraid/_automations/read?ref=             one automation → {row}
//   POST /centraid/_automations/turn-now?ref=         fire now → {turnId}
//   POST /centraid/_automations/invoke-and-await?ref= run payload → outcome
//   GET  /centraid/_automations/turns?ref=&limit=     turn feed → {turns}
//   GET  /centraid/_automations/turn?turnId=          one turn → {turn}
//   POST /centraid/_automations/turn?ref=             interactive turn → TurnStreamEvent SSE
//   GET  /centraid/_automations/turn/items?turnId=    item timeline → {items}
//   POST /centraid/_automations/turn/pin?turnId=      body {pinned} → {ok}
//   GET  /centraid/_insights/summary?windowDays=      insights payload
//
// Code (manifests) resolves from the git-store materialized `main`
// (`<active-main>/apps`); data (run ledgers, analytics) from the
// gateway's stable `appsDir`. Turn-now executes on THIS host with the
// gateway's own harness config — the desktop's provider key is not used
// for a remote fire.

import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import * as automation from "@centraid/server/automation";
import type {
  AnalyticsStore,
  InsightsStore,
  TurnAttachmentRef,
  ConversationStore,
  Item,
  Turn,
  AutomationTurnStreamEvent,
  TurnStreamEvent,
  HarnessKind,
} from "@centraid/server/engine";
import {
  isHarnessKind,
  parseTurnAttachmentRefs,
  SseStream,
} from "@centraid/server/engine";

import {
  isSystemRecognitionRef,
  SYSTEM_RECOGNITION_REFS,
} from "../enrich/system-recognition.js";
import { journalConversationStore } from "../journal-stores.js";
import type { WorktreeStore } from "../worktree-store/index.js";
import {
  parseProviderConsent,
  readJson,
  sendError,
  sendJson,
} from "./route-helpers.js";
import { SseSubscriberCap } from "./sse-cap.js";

/**
 * The production subscriber cap for `/centraid/_automations/turn/events` —
 * one gateway process serves one of these (`buildGateway` calls
 * `makeAutomationsRouteHandler` with no override), so this instance's live
 * count IS the real count (issue #351).
 */
const defaultSubscriberCap = new SseSubscriberCap();

/** Live subscriber count on the automation turn-events SSE stream. */
export function turnEventsSubscriberCount(): number {
  return defaultSubscriberCap.current();
}

export interface AutomationsRouteOptions {
  /** Git store — code (manifests) resolve from `<getActiveMainLink()>/apps`. */
  store: WorktreeStore;
  /** The vault's `journal.db` — every turn's full ledger lives here (#280). */
  journalDbFile: string;
  /** The vault's run-summary rollup (same file as the ledger, #280). */
  analytics: AnalyticsStore;
  /** Insights aggregator over the same rollup. */
  insights: InsightsStore;
  /**
   * Fire an automation now (fire-and-forget). Injected so `serve()` wires the
   * automation handler with the gateway's directories + turn driver, and tests can
   * stub it. The turnId is minted by the route and passed in.
   */
  runAutomation: (input: { automationRef: string; turnId: string }) => void;
  /** The same fire path, awaited for capture and the Test run affordance. */
  invokeAndAwait?: (input: {
    automationRef: string;
    turnId: string;
    payload?: unknown;
  }) => Promise<unknown>;
  /**
   * Subscribe to a turn's live native events. Wired to the gateway event bus.
   * Returns an unsubscribe. Omitted in hosts that
   * don't stream — the SSE endpoint then replays the ledger and closes.
   */
  subscribeTurnEvents?: (
    turnId: string,
    listener: (ev: AutomationTurnStreamEvent, serialized: string) => void
  ) => () => void;
  /**
   * Drive a real interactive automation turn. The route owns the standard
   * `TurnStreamEvent` SSE transport; the injected lifecycle owns ledger,
   * scoped harness dispatch, and automation-bus fanout.
   */
  runInteractiveTurn?: (input: {
    row: automation.Row;
    turnId: string;
    message: string;
    abortSignal: AbortSignal;
    onEvent: (event: TurnStreamEvent) => void;
    providerConsent?: HarnessKind | readonly HarnessKind[];
    harnessKind?: HarnessKind;
    model?: string;
    thinking?: string;
    attachmentRefs?: TurnAttachmentRef[];
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
  /** Active harness binding on the stable automation conversation. */
  harnessKind?: string;
  /** Built-in recognition runs stay in their own history lane. */
  systemLane?: "recognition";
}

/**
 * Reconstruct a durable ledger item as live-stream events for SSE replay: an
 * `item.start`, plus an `item.end` when the item has finished (in-flight items
 * — `endedAt` NULL — replay as start-only and finish live off the bus). The
 * inbound `message_in` item is not a trace node and is filtered by the caller.
 */
function replayItemEvents(item: Item): AutomationTurnStreamEvent[] {
  const start: AutomationTurnStreamEvent = {
    type: "item.start",
    itemId: item.itemId,
    ordinal: item.ordinal,
    ...(item.callId === undefined ? {} : { callId: item.callId }),
    ...(item.batchId === undefined ? {} : { batchId: item.batchId }),
    kind: item.kind,
    ...(item.name === undefined ? {} : { name: item.name }),
    ...(item.argsJson === undefined
      ? {}
      : { args: safeParseJson(item.argsJson) }),
    ...(item.rawJson === undefined ? {} : { rawJson: item.rawJson }),
  };
  if (item.endedAt === undefined) return [start];
  const end: AutomationTurnStreamEvent = {
    type: "item.end",
    itemId: item.itemId,
    ordinal: item.ordinal,
    ...(item.callId === undefined ? {} : { callId: item.callId }),
    ok: item.ok,
    ...(item.outputJson === undefined
      ? {}
      : { result: safeParseJson(item.outputJson) }),
    ...(item.error === undefined ? {} : { error: item.error }),
    durationMs: item.durationMs ?? 0,
    ...(item.rawJson === undefined ? {} : { rawJson: item.rawJson }),
  };
  return [start, end];
}

/** Enrich the native row with its automation conversation identity. */
function turnToAutomationTurn(
  turn: Turn,
  automationRef: string | undefined,
  conversationTitle: string | undefined,
  harnessKind: string | undefined
): AutomationTurnJson {
  return {
    ...turn,
    ...(automationRef === undefined ? {} : { automationId: automationRef }),
    ...(conversationTitle ? { automationName: conversationTitle } : {}),
    ...(harnessKind ? { harnessKind } : {}),
    ...(isSystemRecognitionRef(automationRef)
      ? { systemLane: "recognition" as const }
      : {}),
  };
}

/**
 * Build the automation/insights route handler. Returns a function
 * suitable for `startRuntimeHttpServer`'s `extraHandlers`: resolves
 * `true` when it owned the request.
 */
export function makeAutomationsRouteHandler(
  opts: AutomationsRouteOptions
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const codeAppsDir = (): string =>
    path.join(opts.store.getActiveMainLink(), "apps");
  const subscriberCap = opts.subscriberCap ?? defaultSubscriberCap;

  // Turn-ledger store — every automation turn's full ledger is the vault's
  // single `journal.db` (#280), so per-execution file resolution is gone. A
  // ledger file that doesn't exist yet just means no turn ever landed here.
  const turnsStore = journalConversationStore(opts.journalDbFile);
  const turnsStoreForTurnId = (
    _turnId: string
  ): ConversationStore | undefined => {
    if (!existsSync(opts.journalDbFile)) return undefined;
    return turnsStore;
  };

  // SSE: stream one run end-to-end (issue #158, ledger-tail hybrid). Subscribe
  // to the bus first (so events during replay aren't lost), replay the durable
  // ledger snapshot, then drain buffered + live events until `turn.end`.
  const streamTurnEvents = (
    req: IncomingMessage,
    res: ServerResponse,
    turnId: string
  ): boolean => {
    const releaseSlot = subscriberCap.admit(res);
    if (!releaseSlot) return true; // 503 + Retry-After already written

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    // Bounded writer (issue #659 G6) — a paused viewer is dropped, not buffered.
    const stream = new SseStream(res);
    stream.comment(`turn ${turnId}`);
    const heartbeat = setInterval(() => {
      stream.comment("ping");
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
    req.on("close", cleanup);
    res.on("error", cleanup);

    const write = (
      ev: AutomationTurnStreamEvent,
      serialized = JSON.stringify(ev)
    ): void => {
      stream.event(ev.type, serialized);
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
        if (ev.type === "turn.end") {
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
    write({ type: "turn.start", turnId });
    const items = store ? store.listItems(turnId) : [];
    for (const item of items) {
      if (item.kind === "message_in") continue;
      for (const ev of replayItemEvents(item)) write(ev);
    }

    // Run already finished (background fire / late join) — emit terminal + close.
    if (turn && turn.endedAt !== undefined) {
      write({
        type: "turn.end",
        turnId,
        ok: turn.ok,
        ...(turn.error === undefined ? {} : { error: turn.error }),
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
    const url = new URL(req.url ?? "/", "http://localhost");
    const { pathname } = url;
    const isAutomations = pathname.startsWith("/centraid/_automations");
    const isInsights = pathname === "/centraid/_insights/summary";
    if (!isAutomations && !isInsights) return false;
    const method = (req.method ?? "GET").toUpperCase();

    try {
      if (isInsights && method === "GET") {
        const windowDays = Number(url.searchParams.get("windowDays"));
        return sendJson(
          res,
          200,
          opts.insights.summary(
            Number.isFinite(windowDays) && windowDays > 0 ? { windowDays } : {}
          )
        );
      }

      const sub = pathname
        .slice("/centraid/_automations".length)
        .replace(/^\/+/u, "");

      if (sub === "" && method === "GET") {
        const listed = await automation.list(codeAppsDir());
        return sendJson(res, 200, {
          ...listed,
          rows: listed.rows.map((row) => ({
            ...row,
            ...(isSystemRecognitionRef(row.ref)
              ? { systemLane: "recognition" as const }
              : {}),
          })),
        });
      }

      if (sub === "read" && method === "GET") {
        const ref = automation.parseRef(url.searchParams.get("ref") ?? "");
        if (!ref) return sendJson(res, 200, { row: null });
        const row = await automation
          .readAppOwned(codeAppsDir(), ref.appId, ref.automationId)
          .catch(() => undefined);
        return sendJson(res, 200, {
          row:
            row && isSystemRecognitionRef(row.ref)
              ? { ...row, systemLane: "recognition" as const }
              : (row ?? null),
        });
      }

      // The compiler's output made legible: the instructions-first editor
      // owns intent, but the deterministic plan the headless compiler writes
      // (`automation.json` + `handler.js`) is what actually runs. Surfacing it
      // read-only lets the owner see exactly what their prose became.
      if (sub === "source" && method === "GET") {
        const ref = automation.parseRef(url.searchParams.get("ref") ?? "");
        if (!ref)
          return sendJson(res, 400, {
            error: "bad_request",
            message: "source needs ?ref=",
          });
        const dir = path.join(
          codeAppsDir(),
          ref.appId,
          "automations",
          ref.automationId
        );
        const read = (file: string): Promise<string | null> =>
          readFile(path.join(dir, file), "utf8").catch(() => null);
        const [manifest, handler] = await Promise.all([
          read(automation.MANIFEST_FILE),
          read(automation.HANDLER_FILE),
        ]);
        return sendJson(res, 200, { manifest, handler });
      }

      if (sub === "turn-now" && method === "POST") {
        const ref = url.searchParams.get("ref") ?? "";
        if (!automation.parseRef(ref)) {
          return sendJson(res, 400, {
            error: "bad_request",
            message: "turn-now needs ?ref=",
          });
        }
        const turnId = `${ref}:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
        opts.runAutomation({ automationRef: ref, turnId });
        return sendJson(res, 202, { turnId });
      }

      if (sub === "invoke-and-await" && method === "POST") {
        const ref = url.searchParams.get("ref") ?? "";
        if (!automation.parseRef(ref) || !opts.invokeAndAwait) {
          return sendJson(res, 400, {
            error: "bad_request",
            message:
              "invoke-and-await needs a valid ?ref= and an enabled fire path",
          });
        }
        const turnId = `${ref}:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
        const payload = await readJson(req);
        const result = await opts.invokeAndAwait({
          automationRef: ref,
          turnId,
          payload,
        });
        return sendJson(res, 200, { turnId, result });
      }

      if (sub === "turns" && method === "GET") {
        const ref = url.searchParams.get("ref");
        const limit = Number(url.searchParams.get("limit"));
        const boundedLimit =
          Number.isFinite(limit) && limit > 0 ? Math.min(limit, 250) : 50;
        // `systemLane` splits the combined feed at the fetch, not after
        // (issue #731 M2). Before this, the unscoped `turns` query filled
        // its one `boundedLimit` window with whatever ran most recently —
        // so a large photo import (which fires the recognition automations
        // once per photo) could fill the entire window with recognition
        // runs and leave a member's own "Recent activity" empty. "member"
        // and "recognition" are each fetched as their own SQL-filtered,
        // independently-bounded query; omitting the param keeps the old
        // combined behavior for other callers.
        const systemLaneParam = url.searchParams.get("systemLane");
        const laneFilter: "member" | "recognition" | undefined =
          systemLaneParam === "member" || systemLaneParam === "recognition"
            ? systemLaneParam
            : undefined;
        if (!existsSync(opts.journalDbFile))
          return sendJson(res, 200, { turns: [] });
        const rows = ref
          ? turnsStore.listAutomationTurns(ref, { limit: boundedLimit })
          : (() => {
              const finishedSummaries =
                laneFilter === "recognition"
                  ? SYSTEM_RECOGNITION_REFS.flatMap((recRef) =>
                      opts.analytics.listSummaries({
                        automationRef: recRef,
                        limit: boundedLimit,
                      })
                    )
                      .sort((a, b) => b.startedAt - a.startedAt)
                      .slice(0, boundedLimit)
                  : opts.analytics.listSummaries({
                      limit: boundedLimit,
                      ...(laneFilter === "member"
                        ? { excludeAutomationRefs: SYSTEM_RECOGNITION_REFS }
                        : {}),
                    });
              const finished = finishedSummaries
                .filter((summary) => summary.kind === "automation")
                .map((summary) => turnsStore.getTurn(summary.runId))
                .filter((turn): turn is Turn => turn !== undefined);
              const seen = new Set(finished.map((turn) => turn.turnId));
              const inFlight =
                laneFilter === "member"
                  ? turnsStore.listInFlightAutomationTurns(boundedLimit, {
                      excludeAutomationRefs: SYSTEM_RECOGNITION_REFS,
                    })
                  : laneFilter === "recognition"
                    ? turnsStore.listInFlightAutomationTurns(boundedLimit, {
                        onlyAutomationRefs: SYSTEM_RECOGNITION_REFS,
                      })
                    : turnsStore.listInFlightAutomationTurns(boundedLimit);
              return [
                ...inFlight.filter((turn) => !seen.has(turn.turnId)),
                ...finished,
              ]
                .sort((a, b) => b.startedAt - a.startedAt)
                .slice(0, boundedLimit);
            })();
        const turns = rows.map((turn) => {
          const conversation = turnsStore.getConversation(turn.conversationId);
          return turnToAutomationTurn(
            turn,
            conversation?.automationId,
            conversation?.title,
            conversation?.harnessKind
          );
        });
        return sendJson(res, 200, { turns });
      }

      if (sub === "turn" && method === "GET") {
        const requestedTurnId = url.searchParams.get("turnId") ?? "";
        const ref = url.searchParams.get("ref") ?? "";
        const store = turnsStoreForTurnId(requestedTurnId);
        const turn =
          store?.getTurn(requestedTurnId) ??
          (ref ? store?.listAutomationTurns(ref, { limit: 1 })[0] : undefined);
        if (!store || !turn) return sendJson(res, 200, { turn: null });
        const conversation = store.getConversation(turn.conversationId);
        const record = turnToAutomationTurn(
          turn,
          conversation?.automationId,
          conversation?.title,
          conversation?.harnessKind
        );
        return sendJson(res, 200, {
          turn: record,
          ...(url.searchParams.get("expand") === "items"
            ? { items: store.listItems(turn.turnId) }
            : {}),
        });
      }

      if (sub === "turn" && method === "POST") {
        const parsed = automation.parseRef(url.searchParams.get("ref") ?? "");
        if (!parsed) {
          return sendJson(res, 400, {
            error: "bad_request",
            message: "turn needs ?ref=",
          });
        }
        if (!opts.runInteractiveTurn) {
          return sendJson(res, 501, {
            error: "not_supported",
            message:
              "Interactive automation turns are not available on this gateway.",
          });
        }
        const row = await automation.readAppOwned(
          codeAppsDir(),
          parsed.appId,
          parsed.automationId
        );
        if (!row) {
          return sendJson(res, 404, {
            error: "not_found",
            message: `Automation "${parsed.appId}/${parsed.automationId}" was not found.`,
          });
        }
        const body = await readJson(req);
        const message =
          typeof body.message === "string" ? body.message.trim() : "";
        if (!message) {
          return sendJson(res, 400, {
            error: "bad_request",
            message: "turn body needs a non-empty {message}",
          });
        }
        const providerConsent = parseProviderConsent(body.providerConsent);
        if (providerConsent === "invalid") {
          return sendJson(res, 400, {
            error: "bad_request",
            message: "providerConsent must name registered harnesses.",
          });
        }
        const harnessKind = isHarnessKind(body.harnessKind)
          ? body.harnessKind
          : undefined;
        if (body.harnessKind !== undefined && !harnessKind) {
          return sendJson(res, 400, {
            error: "bad_request",
            message: "harnessKind must name a registered harness.",
          });
        }
        const model =
          typeof body.model === "string" && body.model ? body.model : undefined;
        const thinking =
          typeof body.thinking === "string" && body.thinking
            ? body.thinking
            : undefined;
        const attachmentRefs = parseTurnAttachmentRefs(body.attachments);
        // Same fd-exhaustion guard as `turn/events` (sse-cap.ts): every
        // accepted request holds an open response, a 30s heartbeat, and —
        // once the per-automation lock clears — an ACP child. A client
        // reconnect loop across N automations must not open N unbounded
        // streams. A refusal is a clean `503` + `Retry-After` JSON body,
        // distinguishable from a dropped stream.
        const releaseSlot = subscriberCap.admit(res);
        if (!releaseSlot) return true; // 503 + Retry-After already written
        const turnId = `${row.ref}:interactive:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
        const abort = new AbortController();
        const onClose = (): void => abort.abort();
        req.on("close", onClose);
        req.on("error", onClose);
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
          "X-Centraid-Turn-Id": turnId,
        });
        // Bounded writer (issue #659 G6).
        const stream = new SseStream(res);
        stream.comment(`automation ${row.ref} turn ${turnId}`);
        const heartbeat = setInterval(() => {
          stream.comment("ping");
        }, 30_000);
        heartbeat.unref?.();
        const onEvent = (event: TurnStreamEvent): void => {
          stream.event(event.type, JSON.stringify(event));
        };
        try {
          await opts.runInteractiveTurn({
            row,
            turnId,
            message,
            ...(providerConsent ? { providerConsent } : {}),
            ...(harnessKind ? { harnessKind } : {}),
            ...(model ? { model } : {}),
            ...(thinking ? { thinking } : {}),
            ...(attachmentRefs.length > 0 ? { attachmentRefs } : {}),
            abortSignal: abort.signal,
            onEvent,
          });
        } catch (error) {
          onEvent({
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          clearInterval(heartbeat);
          req.off("close", onClose);
          req.off("error", onClose);
          releaseSlot();
          stream.event("end", "{}");
          stream.end();
        }
        return true;
      }

      if (sub === "turn/items" && method === "GET") {
        const turnId = url.searchParams.get("turnId") ?? "";
        const store = turnsStoreForTurnId(turnId);
        return sendJson(res, 200, { items: store?.listItems(turnId) ?? [] });
      }

      if (sub === "turn/events" && method === "GET") {
        const turnId = url.searchParams.get("turnId") ?? "";
        if (!turnId) {
          return sendJson(res, 400, {
            error: "bad_request",
            message: "turn/events needs ?turnId=",
          });
        }
        return streamTurnEvents(req, res, turnId);
      }

      if (sub === "turn/pin" && method === "POST") {
        const turnId = url.searchParams.get("turnId") ?? "";
        const body = await readJson(req);
        const pinned = body.pinned === true;
        // turns.pinned is the source — the run_summary view reflects it.
        turnsStoreForTurnId(turnId)?.setTurnPinned(turnId, pinned);
        return sendJson(res, 200, { ok: true });
      }

      return false;
    } catch (error) {
      return sendError(res, error);
    }
  };
}
