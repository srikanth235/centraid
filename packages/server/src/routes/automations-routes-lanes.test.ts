import crypto from "node:crypto";
/*
 * `GET /_automations/turns?systemLane=` lane split (issue #731 M2). Same
 * mock req/res harness as automations-routes.test.ts, split out so the
 * flood-isolation scenario has room of its own.
 */
import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import { describe, afterEach, beforeEach, expect, test } from "vitest";

import {
  AnalyticsStore,
  ConversationStore,
  InsightsStore,
  makeJournalDbProvider,
} from "@centraid/server/engine";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { WorktreeStore } from "../worktree-store/index.js";
import { makeAutomationsRouteHandler } from "./automations-routes.ts";

let dir: string;
let handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
describe("automations-routes systemLane suite", () => {
  beforeEach(async () => {
    dir = await tempDir(`auto-routes-lanes-${crypto.randomUUID()}-`);
    const journalDbFile = path.join(dir, "journal.db");
    const provider = makeJournalDbProvider(journalDbFile);
    handler = makeAutomationsRouteHandler({
      store: new WorktreeStore({ root: path.join(dir, "code") }),
      journalDbFile,
      analytics: new AnalyticsStore(provider),
      insights: new InsightsStore(provider),
      runAutomation: () => {},
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

  async function call(method: string, url: string): Promise<Captured> {
    const req = {
      method,
      url,
      async *[Symbol.asyncIterator]() {},
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

  // Issue #731 M2: an unsplit `turns` feed hands back whichever `limit` turns
  // ran most recently, so a flood of recognition runs (a large photo import
  // fires them once per photo) fills the whole window and leaves the member's
  // own "Recent activity" empty. `systemLane=member`/`systemLane=recognition`
  // are separate, independently-bounded SQL queries; a flood on one must never
  // starve the other.
  test("systemLane splits the turns feed so a recognition flood can't starve the member lane", async () => {
    const store = new ConversationStore(
      makeJournalDbProvider(path.join(dir, "journal.db"))
    );
    const memberRef = "brief/brief";
    const memberConversationId = store.ensureAutomationConversation(
      memberRef,
      "brief",
      "Daily Brief"
    );
    store.insertTurn({
      turnId: `${memberRef}:1:aaaaaaaa`,
      conversationId: memberConversationId,
      triggerKind: "scheduled",
      triggerOrigin: "cron",
      startedAt: 1,
    });
    store.finishTurn({
      turnId: `${memberRef}:1:aaaaaaaa`,
      endedAt: 2,
      ok: true,
    });

    const recognitionRef = "photo-ocr/photo-ocr";
    const recognitionConversationId = store.ensureAutomationConversation(
      recognitionRef,
      "photo-ocr",
      "Photo OCR"
    );
    for (let i = 0; i < 10; i++) {
      const turnId = `${recognitionRef}:${1000 + i}:aaaaaaa${i}`;
      store.insertTurn({
        turnId,
        conversationId: recognitionConversationId,
        triggerKind: "manual",
        triggerOrigin: "manual",
        startedAt: 1000 + i,
      });
      store.finishTurn({ turnId, endedAt: 1000 + i + 1, ok: true });
    }

    const member = await call(
      "GET",
      "/centraid/_automations/turns?systemLane=member&limit=5"
    );
    const memberTurns = (
      member.body as { turns: Array<{ turnId: string; automationId?: string }> }
    ).turns;
    expect(memberTurns.map((t) => t.turnId)).toContain(
      `${memberRef}:1:aaaaaaaa`
    );
    expect(memberTurns.every((t) => t.automationId !== recognitionRef)).toBe(
      true
    );

    const recognition = await call(
      "GET",
      "/centraid/_automations/turns?systemLane=recognition&limit=5"
    );
    const recognitionTurns = (
      recognition.body as {
        turns: Array<{ turnId: string; systemLane?: string }>;
      }
    ).turns;
    expect(recognitionTurns).toHaveLength(5);
    expect(recognitionTurns.every((t) => t.systemLane === "recognition")).toBe(
      true
    );
  });
});
