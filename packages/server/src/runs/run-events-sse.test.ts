import crypto from "node:crypto";
/*
 * SSE streaming for automation runs (#158): the
 * `GET /centraid/_automations/turn/events?turnId=` endpoint. Drives
 * `makeAutomationsRouteHandler` with a mock streaming req/res, a real
 * per-app run ledger over a tempdir, and a `RunEventBus` for the live path.
 */
import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  ConversationStore,
  AnalyticsStore,
  InsightsStore,
  makeLedgerDbProvider,
} from "@centraid/server/engine";
import type { AutomationTurnStreamEvent } from "@centraid/server/engine";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { ledgerDbFileIn } from "../engine/stores/ledger-db.test-fixtures.js";
import { makeAutomationsRouteHandler } from "../routes/automations-routes.ts";
import { WorktreeStore } from "../worktree-store/index.js";
import { RunEventBus } from "./run-event-bus.ts";

let dir: string;
let analytics: AnalyticsStore;
let bus: RunEventBus;
let handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

const APP = "brief";

/** Open the vault ledger the route reads (one vault.db, #280). */
function ledger(): ConversationStore {
  return new ConversationStore(makeLedgerDbProvider(ledgerDbFileIn(dir)));
}

/** Seed one automation fire turn under its stable conversation. */
function seedTurn(
  store: ConversationStore,
  ref: string,
  turnId: string,
  startedAt: number
): void {
  const convId = store.ensureAutomationConversation(ref, ref.split("/")[0]);
  store.insertTurn({
    turnId,
    conversationId: convId,
    triggerKind: "manual",
    startedAt,
  });
}

describe("run-events-sse", () => {
  beforeEach(async () => {
    dir = await tempDir(`run-sse-${crypto.randomUUID()}-`);
    await fs.mkdir(path.join(dir, "apps", APP), { recursive: true });
    const ledgerDbFile = ledgerDbFileIn(dir);
    const provider = makeLedgerDbProvider(ledgerDbFile);
    analytics = new AnalyticsStore(provider);
    bus = new RunEventBus();
    handler = makeAutomationsRouteHandler({
      store: new WorktreeStore({ root: path.join(dir, "code") }),
      ledgerDbFile,
      analytics,
      insights: new InsightsStore(provider),
      runAutomation: () => undefined,
      subscribeTurnEvents: (turnId, listener) =>
        bus.subscribe(turnId, listener),
    });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  interface SseClient {
    req: IncomingMessage;
    res: ServerResponse;
    events: () => AutomationTurnStreamEvent[];
    ended: () => boolean;
  }

  function sseClient(url: string): SseClient {
    const chunks: string[] = [];
    let isEnded = false;
    const res = {
      writableEnded: false,
      statusCode: 0,
      writeHead(status: number) {
        this.statusCode = status;
        return this;
      },
      setHeader() {},
      write(s: string) {
        chunks.push(s);
        return true;
      },
      end() {
        isEnded = true;
        this.writableEnded = true;
      },
      on() {
        return this;
      },
    };
    const req = {
      method: "GET",
      url,
      on() {
        return this;
      },
    };
    return {
      req: req as unknown as IncomingMessage,
      res: res as unknown as ServerResponse,
      ended: () => isEnded,
      events: () =>
        chunks
          .join("")
          .split("\n\n")
          .map((frame) => frame.split("\n").find((l) => l.startsWith("data: ")))
          .filter((l): l is string => l !== undefined)
          .map(
            (l) =>
              JSON.parse(l.slice("data: ".length)) as AutomationTurnStreamEvent
          ),
    };
  }

  test("replays a finished run from the ledger then closes", async () => {
    const runId = `${APP}/digest:${Date.now()}:abcd1234`;
    const store = ledger();
    seedTurn(store, `${APP}/digest`, runId, 1);
    store.openItem({
      itemId: "n0",
      turnId: runId,
      ordinal: 0,
      kind: "tool",
      name: "http.get",
      startedAt: 2,
    });
    store.closeItem({
      itemId: "n0",
      ok: true,
      outputJson: '{"status":200}',
      endedAt: 5,
      durationMs: 3,
    });
    store.finishTurn({ turnId: runId, endedAt: 6, ok: true, summary: "done" });

    const c = sseClient(
      `/centraid/_automations/turn/events?turnId=${encodeURIComponent(runId)}`
    );
    const owned = await handler(c.req, c.res);

    expect(owned).toBe(true);
    expect(c.res.statusCode).toBe(200);
    expect(c.ended()).toBe(true);
    const evs = c.events();
    expect(evs.map((e) => e.type)).toStrictEqual([
      "turn.start",
      "item.start",
      "item.end",
      "turn.end",
    ]);
    const end = evs[3] as Extract<
      AutomationTurnStreamEvent,
      { type: "turn.end" }
    >;
    expect(end.ok).toBe(true);
    // No live subscriber should linger for a closed run.
    expect(bus.subscriberCount(runId)).toBe(0);
  });

  test("joins an in-flight run: replays the open node, then streams live to turn.end", async () => {
    const runId = `${APP}/watch:${Date.now()}:beef0000`;
    const store = ledger();
    seedTurn(store, `${APP}/watch`, runId, 1);
    // One item already running (opened, not closed) when the viewer joins.
    store.openItem({
      itemId: "n0",
      turnId: runId,
      ordinal: 0,
      kind: "delegate",
      name: "delegate",
      startedAt: 2,
    });

    const c = sseClient(
      `/centraid/_automations/turn/events?turnId=${encodeURIComponent(runId)}`
    );
    await handler(c.req, c.res);

    // Replay: turn.start + the open node's start (no end yet). Still live.
    expect(c.events().map((e) => e.type)).toStrictEqual([
      "turn.start",
      "item.start",
    ]);
    expect(c.ended()).toBe(false);
    expect(bus.subscriberCount(runId)).toBe(1);

    // The fire finishes the node and the run — delivered live off the bus.
    bus.publish(runId, {
      type: "item.end",
      itemId: "n0",
      ordinal: 0,
      ok: true,
      result: "hi",
      durationMs: 40,
    });
    bus.publish(runId, { type: "turn.end", turnId: runId, ok: true });

    expect(c.events().map((e) => e.type)).toStrictEqual([
      "turn.start",
      "item.start",
      "item.end",
      "turn.end",
    ]);
    expect(c.ended()).toBe(true);
    expect(bus.subscriberCount(runId)).toBe(0);
  });

  test("a fire that fails before the ledger opens still closes via a bus turn.end", async () => {
    // No insertRun: `fireAutomation` threw before the handler runner opened the
    // ledger (bad ref / automation gone / dispatch setup failure). `run-now`
    // already handed the caller this runId and the viewer subscribed, so without
    // a terminal event the stream would hang. build-gateway's catch publishes a
    // synthetic turn.end — this proves the SSE side honors it and closes.
    const runId = `${APP}/broken:${Date.now()}:dead0000`;
    const c = sseClient(
      `/centraid/_automations/turn/events?turnId=${encodeURIComponent(runId)}`
    );
    await handler(c.req, c.res);

    // Synthetic turn.start written, no ledger nodes, still live on the bus.
    expect(c.events().map((e) => e.type)).toStrictEqual(["turn.start"]);
    expect(c.ended()).toBe(false);
    expect(bus.subscriberCount(runId)).toBe(1);

    bus.publish(runId, {
      type: "turn.end",
      turnId: runId,
      ok: false,
      error: "automation not found",
    });

    const evs = c.events();
    expect(evs.map((e) => e.type)).toStrictEqual(["turn.start", "turn.end"]);
    const end = evs[1] as Extract<
      AutomationTurnStreamEvent,
      { type: "turn.end" }
    >;
    expect(end.ok).toBe(false);
    expect(end.error).toBe("automation not found");
    expect(c.ended()).toBe(true);
    expect(bus.subscriberCount(runId)).toBe(0);
  });

  test("run/events without ?turnId= is a 400", async () => {
    const c = sseClient("/centraid/_automations/turn/events");
    await handler(c.req, c.res);
    expect(c.res.statusCode).toBe(400);
  });
});
