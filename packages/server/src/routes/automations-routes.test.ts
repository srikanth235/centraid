import crypto from "node:crypto";
/*
 * Automation/insights HTTP routes (issue #141). Drives
 * `makeAutomationsRouteHandler` with mock req/res, real (empty) stores
 * over a tempdir, and a stub `runAutomation` so turn-now is observable
 * without spawning a CLI.
 */
import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import { describe, afterEach, beforeEach, expect, test, vi } from "vitest";

import {
  AnalyticsStore,
  ConversationStore,
  InsightsStore,
  makeJournalDbProvider,
} from "@centraid/server/engine";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { WorktreeStore } from "../worktree-store/index.js";
import { makeAutomationsRouteHandler } from "./automations-routes.ts";
import { SseSubscriberCap } from "./sse-cap.ts";

let dir: string;
let analytics: AnalyticsStore;
let insights: InsightsStore;
let fired: Array<{ automationRef: string; turnId: string }>;
let handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
describe("automations-routes suite", () => {
  beforeEach(async () => {
    dir = await tempDir(`auto-routes-${crypto.randomUUID()}-`);
    const journalDbFile = path.join(dir, "journal.db");
    const provider = makeJournalDbProvider(journalDbFile);
    analytics = new AnalyticsStore(provider);
    insights = new InsightsStore(provider);
    fired = [];
    handler = makeAutomationsRouteHandler({
      store: new WorktreeStore({ root: path.join(dir, "code") }),
      journalDbFile,
      analytics,
      insights,
      runAutomation: (input) => fired.push(input),
    });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  interface Captured {
    owned: boolean;
    status: number;
    body: unknown;
  }

  async function call(
    method: string,
    url: string,
    jsonBody?: unknown
  ): Promise<Captured> {
    const req = {
      method,
      url,
      async *[Symbol.asyncIterator]() {
        if (jsonBody !== undefined) yield Buffer.from(JSON.stringify(jsonBody));
      },
    } as unknown as IncomingMessage;
    let raw = "";
    const res = {
      statusCode: 0,
      setHeader() {},
      end(b?: string) {
        raw = b ?? "";
      },
    };
    const owned = await handler(req, res as unknown as ServerResponse);
    return {
      owned,
      status: res.statusCode,
      body: raw ? JSON.parse(raw) : null,
    };
  }

  test("ignores paths it does not own", async () => {
    const r = await call("GET", "/centraid/_apps");
    expect(r.owned).toBe(false);
  });

  test("GET /centraid/_automations lists (empty store)", async () => {
    const r = await call("GET", "/centraid/_automations");
    expect(r.owned).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body).toStrictEqual({ rows: [], errors: [] });
  });

  test("GET /centraid/_automations/read?ref= returns null when absent", async () => {
    const r = await call("GET", "/centraid/_automations/read?ref=appx/x");
    expect(r.status).toBe(200);
    expect(r.body).toStrictEqual({ row: null });
  });

  test("POST turn-now mints a turnId and invokes the injected runAutomation", async () => {
    const r = await call(
      "POST",
      "/centraid/_automations/turn-now?ref=brief/brief"
    );
    expect(r.status).toBe(202);
    const { turnId } = r.body as { turnId: string };
    expect(turnId).toMatch(/^brief\/brief:\d+:[0-9a-f]{8}$/u);
    expect(fired).toStrictEqual([{ automationRef: "brief/brief", turnId }]);
  });

  test("POST turn-now without ?ref= is a 400", async () => {
    const r = await call("POST", "/centraid/_automations/turn-now");
    expect(r.status).toBe(400);
    expect(fired).toHaveLength(0);
  });

  test("POST invoke-and-await passes the payload through one awaited fire", async () => {
    const invoked: Array<{
      automationRef: string;
      turnId: string;
      payload?: unknown;
    }> = [];
    handler = makeAutomationsRouteHandler({
      store: new WorktreeStore({ root: path.join(dir, "code") }),
      journalDbFile: path.join(dir, "journal.db"),
      analytics,
      insights,
      runAutomation: (input) => fired.push(input),
      invokeAndAwait: async (input) => {
        invoked.push(input);
        return { turnId: input.turnId, outcome: { ok: true } };
      },
    });

    const r = await call(
      "POST",
      "/centraid/_automations/invoke-and-await?ref=photo-ocr/photo-ocr",
      { capture: { bytes: "cmVjZWlwdA==", mediaType: "image/jpeg" } }
    );

    expect(r.status).toBe(200);
    const body = r.body as {
      turnId: string;
      result: { turnId: string; outcome: { ok: boolean } };
    };
    expect(body.turnId).toMatch(/^photo-ocr\/photo-ocr:\d+:[0-9a-f]{8}$/u);
    expect(body.result).toStrictEqual({
      turnId: body.turnId,
      outcome: { ok: true },
    });
    expect(invoked).toStrictEqual([
      {
        automationRef: "photo-ocr/photo-ocr",
        turnId: body.turnId,
        payload: {
          capture: { bytes: "cmVjZWlwdA==", mediaType: "image/jpeg" },
        },
      },
    ]);
  });

  test("POST turn validates its ref and is capability-guarded when no executor is wired", async () => {
    const missingRef = await call("POST", "/centraid/_automations/turn", {
      message: "What changed?",
    });
    expect(missingRef.status).toBe(400);
    const unsupported = await call(
      "POST",
      "/centraid/_automations/turn?ref=brief/brief",
      {
        message: "What changed?",
      }
    );
    expect(unsupported.status).toBe(501);
    expect(unsupported.body).toMatchObject({ error: "not_supported" });
  });

  test("GET /centraid/_automations/turns returns an empty feed", async () => {
    const r = await call("GET", "/centraid/_automations/turns?limit=10");
    expect(r.status).toBe(200);
    expect(r.body).toStrictEqual({ turns: [] });
  });

  // The `run_summary` view only covers finished turns; the thread screen stays
  // put on "Run now", so the ref-scoped feed must surface an IN-FLIGHT fire
  // (started, not ended) as a running record or a slow run is invisible.
  test("GET turns includes an in-flight fire in both thread and global feeds", async () => {
    const store = new ConversationStore(
      makeJournalDbProvider(path.join(dir, "journal.db"))
    );
    const ref = "brief/brief";
    const conversationId = store.ensureAutomationConversation(
      ref,
      "brief",
      "Brief"
    );
    store.noteTurn(conversationId, "", {
      kind: "copilot",
      sessionId: "copilot-session",
    });
    store.insertTurn({
      turnId: `${ref}:100:aaaaaaaa`,
      conversationId,
      triggerKind: "manual",
      triggerOrigin: "manual",
      startedAt: 100,
    });
    store.insertTurn({
      turnId: `${ref}:50:bbbbbbbb`,
      conversationId,
      triggerKind: "manual",
      triggerOrigin: "manual",
      startedAt: 50,
    });
    store.finishTurn({ turnId: `${ref}:50:bbbbbbbb`, endedAt: 60, ok: true });

    const r = await call(
      "GET",
      `/centraid/_automations/turns?ref=${encodeURIComponent(ref)}`
    );
    expect(r.status).toBe(200);
    const turns = (
      r.body as {
        turns: Array<{
          turnId: string;
          endedAt?: number;
          ok: boolean;
          harnessKind?: string;
        }>;
      }
    ).turns;
    expect(turns.map((x) => x.turnId)).toStrictEqual([
      `${ref}:100:aaaaaaaa`,
      `${ref}:50:bbbbbbbb`,
    ]);
    expect(turns[0]?.endedAt).toBeUndefined(); // in-flight → renders as "running"
    expect(turns[1]?.endedAt).toBe(60);
    expect(turns.map((turn) => turn.harnessKind)).toStrictEqual([
      "copilot",
      "copilot",
    ]);
    // No ref filter → the fleet activity feed also sees the in-flight turn.
    const all = await call("GET", "/centraid/_automations/turns?limit=10");
    const allRuns = (all.body as { turns: Array<{ turnId: string }> }).turns;
    expect(allRuns.map((x) => x.turnId)).toStrictEqual([
      `${ref}:100:aaaaaaaa`,
      `${ref}:50:bbbbbbbb`,
    ]);
  });

  test("GET /centraid/_automations/turn?turnId= returns null for an unknown run", async () => {
    const r = await call(
      "GET",
      "/centraid/_automations/turn?turnId=appx/x:1:deadbeef"
    );
    expect(r.status).toBe(200);
    expect(r.body).toStrictEqual({ turn: null });
  });

  test("recognition turns carry a distinct system history lane", async () => {
    const store = new ConversationStore(
      makeJournalDbProvider(path.join(dir, "journal.db"))
    );
    const ref = "photo-ocr/photo-ocr";
    const conversationId = store.ensureAutomationConversation(
      ref,
      "photo-ocr",
      "Photo OCR"
    );
    store.insertTurn({
      turnId: `${ref}:100:aaaaaaaa`,
      conversationId,
      triggerKind: "manual",
      triggerOrigin: "manual",
      startedAt: 100,
    });
    store.finishTurn({
      turnId: `${ref}:100:aaaaaaaa`,
      endedAt: 110,
      ok: true,
    });

    const r = await call(
      "GET",
      `/centraid/_automations/turns?ref=${encodeURIComponent(ref)}`
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      turns: [
        {
          automationId: ref,
          automationName: "Photo OCR",
          systemLane: "recognition",
        },
      ],
    });
  });

  test("turn/items returns native item fields and legacy run/node routes are gone", async () => {
    const store = new ConversationStore(
      makeJournalDbProvider(path.join(dir, "journal.db"))
    );
    const conversationId = store.ensureAutomationConversation(
      "brief/native",
      "brief",
      "Native"
    );
    store.insertTurn({
      turnId: "turn-native",
      conversationId,
      triggerKind: "manual",
      startedAt: 1,
    });
    store.openItem({
      itemId: "item-native",
      turnId: "turn-native",
      ordinal: 0,
      callId: "call-native",
      kind: "tool",
      name: "read_file",
      rawJson: '{"status":"pending"}',
      startedAt: 2,
    });
    const native = await call(
      "GET",
      "/centraid/_automations/turn/items?turnId=turn-native"
    );
    expect(native.body).toStrictEqual({
      items: [
        expect.objectContaining({
          itemId: "item-native",
          turnId: "turn-native",
          callId: "call-native",
          rawJson: '{"status":"pending"}',
        }),
      ],
    });
    const latestExpanded = await call(
      "GET",
      "/centraid/_automations/turn?ref=brief/native&expand=items"
    );
    expect(latestExpanded.body).toMatchObject({
      turn: { turnId: "turn-native", automationId: "brief/native" },
      items: [{ itemId: "item-native", callId: "call-native" }],
    });
    await expect(
      call("GET", "/centraid/_automations/runs")
    ).resolves.toMatchObject({
      owned: false,
    });
    await expect(
      call("POST", "/centraid/_automations/run-now?ref=brief/brief")
    ).resolves.toMatchObject({
      owned: false,
    });
    await expect(
      call("GET", "/centraid/_automations/run?runId=turn-native")
    ).resolves.toMatchObject({
      owned: false,
    });
    await expect(
      call("GET", "/centraid/_automations/run/nodes?runId=turn-native")
    ).resolves.toMatchObject({
      owned: false,
    });
  });

  test("GET /centraid/_insights/summary returns a payload object", async () => {
    const r = await call("GET", "/centraid/_insights/summary?windowDays=30");
    expect(r.owned).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body).toBeTypeOf("object");
    expect(r.body).not.toBeNull();
  });

  // Issue #351: run/events SSE was unbounded — a small cap (2) makes the
  // "cap+1" scenario cheap to exercise. `subscribeTurnEvents` is wired to a
  // no-op unsub (never fires `turn.end`) so the stream stays open under test,
  // same as a real live run being watched.
  interface SseMockClient {
    req: IncomingMessage;
    res: ServerResponse;
    status: () => number;
    header: (name: string) => string | undefined;
    body: () => string;
    ended: () => boolean;
    close: () => void;
  }

  /** The same mock client as a POST with a JSON steering body. */
  function turnPost(
    client: SseMockClient,
    message = "What changed?"
  ): IncomingMessage {
    const body = JSON.stringify({ message });
    return {
      ...(client.req as unknown as Record<string, unknown>),
      method: "POST",
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(body);
      },
      on: (
        client.req as unknown as { on: (e: string, fn: () => void) => unknown }
      ).on.bind(client.req),
      off: () => undefined,
    } as unknown as IncomingMessage;
  }

  function sseClient(url: string): SseMockClient {
    const chunks: string[] = [];
    const headers = new Map<string, string>();
    let isEnded = false;
    let closeListener: (() => void) | undefined;
    const res = {
      writableEnded: false,
      statusCode: 0,
      writeHead(status: number) {
        this.statusCode = status;
        return this;
      },
      setHeader(name: string, value: string) {
        headers.set(name.toLowerCase(), value);
      },
      write(s: string) {
        chunks.push(s);
        return true;
      },
      end(s?: string) {
        if (s) chunks.push(s);
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
      on(event: string, fn: () => void) {
        if (event === "close") closeListener = fn;
        return this;
      },
    };
    return {
      req: req as unknown as IncomingMessage,
      res: res as unknown as ServerResponse,
      status: () => res.statusCode,
      header: (name: string) => headers.get(name.toLowerCase()),
      body: () => chunks.join(""),
      ended: () => isEnded,
      close: () => closeListener?.(),
    };
  }

  /** Put one publishable automation where `codeAppsDir()` will find it. */
  async function seedAutomation(
    store: WorktreeStore,
    appId: string
  ): Promise<void> {
    const automationDir = path.join(
      store.getActiveMainLink(),
      "apps",
      appId,
      "automations",
      appId
    );
    await fs.mkdir(automationDir, { recursive: true });
    await fs.writeFile(
      path.join(automationDir, "automation.json"),
      JSON.stringify({
        name: "Daily brief",
        version: "0.1.0",
        enabled: true,
        prompt: "Summarize.",
        triggers: [],
        history: { keep: { count: 10 } },
        generated: { by: "test", at: "2026-07-25T00:00:00.000Z" },
      })
    );
  }

  test("interactive turn subscribers past the cap get 503 + Retry-After instead of a dropped stream", async () => {
    const store = new WorktreeStore({ root: path.join(dir, "code") });
    await seedAutomation(store, "brief");
    const cap = new SseSubscriberCap(1);
    let released: (() => void) | undefined;
    const capped = makeAutomationsRouteHandler({
      store,
      journalDbFile: path.join(dir, "journal.db"),
      analytics,
      insights,
      runAutomation: (input) => fired.push(input),
      // Holds the turn open (like a real ACP child) so the slot stays taken.
      runInteractiveTurn: () =>
        new Promise((resolve) => {
          released = () => resolve();
        }),
      subscriberCap: cap,
    });

    const first = sseClient("/centraid/_automations/turn?ref=brief/brief");
    const firstDone = capped(turnPost(first), first.res);
    await vi.waitFor(() => expect(cap.current()).toBe(1));

    const second = sseClient("/centraid/_automations/turn?ref=brief/brief");
    await expect(capped(turnPost(second), second.res)).resolves.toBe(true);
    expect(second.status()).toBe(503);
    expect(second.header("Retry-After")).toBeDefined();
    expect((JSON.parse(second.body()) as { error: string }).error).toBe(
      "sse_capacity"
    );
    // A refusal is a complete, distinguishable response — not a half-open stream.
    expect(second.ended()).toBe(true);

    released?.();
    await expect(firstDone).resolves.toBe(true);
    expect(cap.current()).toBe(0);
  });

  test("run/events subscribers past the cap get 503 + Retry-After; the count decrements on disconnect", async () => {
    const cap = new SseSubscriberCap(2);
    const capped = makeAutomationsRouteHandler({
      store: new WorktreeStore({ root: path.join(dir, "code") }),
      journalDbFile: path.join(dir, "journal.db"),
      analytics,
      insights,
      runAutomation: (input) => fired.push(input),
      subscribeTurnEvents: () => () => undefined, // keeps the stream open, like a real live run
      subscriberCap: cap,
    });

    const a = sseClient("/centraid/_automations/turn/events?turnId=r1");
    const b = sseClient("/centraid/_automations/turn/events?turnId=r2");
    await expect(capped(a.req, a.res)).resolves.toBe(true);
    await expect(capped(b.req, b.res)).resolves.toBe(true);
    expect(a.status()).toBe(200);
    expect(b.status()).toBe(200);
    expect(cap.current()).toBe(2);

    const c = sseClient("/centraid/_automations/turn/events?turnId=r3");
    await expect(capped(c.req, c.res)).resolves.toBe(true);
    expect(c.status()).toBe(503);
    expect(c.header("Retry-After")).toBeDefined();
    const errBody = JSON.parse(c.body()) as { error: string };
    expect(errBody.error).toBe("sse_capacity");
    expect(c.ended()).toBe(true);
    expect(cap.current()).toBe(2);

    a.close();
    expect(cap.current()).toBe(1);
    const d = sseClient("/centraid/_automations/turn/events?turnId=r4");
    await expect(capped(d.req, d.res)).resolves.toBe(true);
    expect(d.status()).toBe(200);
    expect(cap.current()).toBe(2);
  });
});
