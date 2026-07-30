import { mkdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

// governance: allow-repo-hygiene file-size-limit #181 — cohesive
// conversation-history suite; the build-kind coverage tips it just over 500
// lines, not worth a split.
import { beforeEach, describe, expect, it } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { makeConversationRouteHandler } from "../http/conversation-routes.js";
import { makeJournalDbProvider } from "../stores/gateway-db.js";
import type { DatabaseProvider } from "../stores/gateway-db.js";
import type { WorkspaceProvider } from "../stores/vault-workspace.js";
import { ConversationHistoryStore, deriveTitle } from "./history.js";
import type { RecordTurnInput } from "./history.js";
import { ConversationStore } from "./store.js";

// Tests that don't care about cross-user isolation share this stub owner id.
const TEST_USER_ID = "test-user-uuid-0000";

// Chat is app-scoped by the `app_id` column inside ONE per-vault
// `journal.db` (#280). Tests build a workspace over a temp vault dir.
const APP = "todos";

function plainRows<T extends object>(rows: T[]): T[] {
  return rows.map((row) => ({ ...row }));
}

/** A fresh temp vault dir with per-app data folders (default `APP`). */
function freshVaultDir(...appIds: string[]): string {
  const dir = tempDirSync("centraid-chat-history-");
  for (const id of appIds.length ? appIds : [APP]) {
    mkdirSync(path.join(dir, "apps", id), { recursive: true });
  }
  return dir;
}

// One cached journal provider per vault dir — mirrors the plane's
// one-connection-per-file doctrine so two stores over the same dir share
// the handle.
const providersByDir = new Map<string, DatabaseProvider>();
function journalFor(dir: string): DatabaseProvider {
  let provider = providersByDir.get(dir);
  if (!provider) {
    provider = makeJournalDbProvider(path.join(dir, "journal.db"));
    providersByDir.set(dir, provider);
  }
  return provider;
}

/** Workspace provider over a temp vault dir, owned by `ownerPartyId`. */
function workspaceFor(
  dir: string,
  ownerPartyId: string = TEST_USER_ID
): WorkspaceProvider {
  return () => ({
    vaultId: "vault-test",
    ownerPartyId,
    appsDir: path.join(dir, "apps"),
    journal: journalFor(dir),
    journalDbFile: path.join(dir, "journal.db"),
    runnerSessionDir: path.join(dir, "runner-sessions"),
  });
}

function newStore(
  ownerPartyId: string = TEST_USER_ID
): ConversationHistoryStore {
  return new ConversationHistoryStore(
    workspaceFor(freshVaultDir(), ownerPartyId)
  );
}

/** Build a minimal one-step chat turn for `recordTurn`. */
function turn(
  conversationId: string,
  userMessage: string,
  reply: string,
  startedAt: number = Date.now()
): RecordTurnInput {
  return {
    conversationId,
    userMessage,
    startedAt,
    endedAt: startedAt + 10,
    ok: true,
    finalText: reply,
    nodes: [{ kind: "step", text: reply, startedAt, endedAt: startedAt + 10 }],
  };
}

describe(deriveTitle, () => {
  it("returns empty for empty/whitespace input", () => {
    expect(deriveTitle("")).toBe("");
    expect(deriveTitle("   \n  ")).toBe("");
  });

  it("passes a short title through; collapses internal whitespace", () => {
    expect(deriveTitle("hello world")).toBe("hello world");
    expect(deriveTitle("a\n\n\nb")).toBe("a b");
  });

  it("truncates at 60 with ellipsis (collapsed first); leaves exactly-60 alone", () => {
    const long = "word ".repeat(40); // 200 chars
    const t = deriveTitle(long);
    expect(t).toHaveLength(58); // 57 + ellipsis
    expect(t.endsWith("…")).toBeTruthy();
    const sixty = "a".repeat(60);
    expect(deriveTitle(sixty)).toBe(sixty);
  });
});

describe(ConversationHistoryStore, () => {
  let store: ConversationHistoryStore;
  beforeEach(() => {
    store = newStore();
  });

  it("createSession + listSessions round-trips", () => {
    const s = store.createSession(APP, "");
    const list = store.listSessions(APP);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(s.id);
    expect(list[0]!.title).toBe("");
    expect(list[0]!.messageCount).toBe(0);
  });

  it("listSessions returns every session for the user in this app", () => {
    store.createSession(APP, "one");
    store.createSession(APP, "two");
    expect(store.listSessions(APP)).toHaveLength(2);
  });

  it("rejects an invalid app id", () => {
    expect(() => store.createSession("../escape")).toThrow(/invalid app id/iu);
  });

  it("recordTurn folds a turn into a run and getSession reconstructs it", () => {
    const s = store.createSession(APP);
    const r = store.recordTurn(APP, turn(s.id, "first", "reply"));
    expect(r?.turnId).toBeTruthy();
    const loaded = store.getSession(APP, s.id);
    expect(loaded?.messages.length).toBe(2);
    expect(loaded?.messages.map((m) => m.idx)).toStrictEqual([0, 1]);
    expect(loaded?.messages[0]!.payload).toStrictEqual({
      kind: "user",
      text: "first",
    });
    expect(loaded?.messages[1]!.payload).toMatchObject({
      kind: "ai",
      text: "reply",
    });
  });

  it("reconstruction tags the terminal answer with its turn id and null feedback (#420)", () => {
    const s = store.createSession(APP);
    const r = store.recordTurn(APP, turn(s.id, "first", "reply"));
    const ai = store.getSession(APP, s.id)?.messages[1]!.payload as {
      turnId?: string;
      feedback?: unknown;
      retry?: unknown;
    };
    expect(ai.turnId).toBe(r?.turnId);
    expect(ai.feedback).toBeNull();
    expect(ai.retry).toBeUndefined();
  });

  it("reconstruction attaches per-turn token/cost usage to the terminal answer (#420 W2)", () => {
    const s = store.createSession(APP);
    store.recordTurn(APP, {
      conversationId: s.id,
      userMessage: "cost?",
      startedAt: 1_000,
      endedAt: 1_020,
      ok: true,
      finalText: "answer",
      nodes: [
        {
          kind: "step",
          text: "answer",
          model: "claude-sonnet-4-5",
          inputTokens: 1200,
          outputTokens: 340,
          startedAt: 1_000,
          endedAt: 1_010,
        },
      ],
    });
    const ai = store.getSession(APP, s.id)?.messages[1]!.payload as {
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        costUsd?: number;
        model?: string;
      };
    };
    expect(ai.usage?.inputTokens).toBe(1200);
    expect(ai.usage?.outputTokens).toBe(340);
    expect(ai.usage?.model).toBe("claude-sonnet-4-5");
    // Frozen cost = 1200/1e6*3 + 340/1e6*15 = 0.0036 + 0.0051 = 0.0087.
    expect(ai.usage?.costUsd).toBeCloseTo(0.0087, 6);
  });

  it("collapses a regenerate into a retry pager showing the latest attempt (#420)", () => {
    const s = store.createSession(APP);
    const first = store.recordTurn(APP, turn(s.id, "why?", "because A", 1_000));
    // A regenerate re-sends the same prompt, pointing retryOf at the first turn.
    const second = store.recordTurn(APP, {
      ...turn(s.id, "why?", "because B", 2_000),
      retryOf: first?.turnId,
    });
    const loaded = store.getSession(APP, s.id);
    // One user row + one ai row (the family is collapsed), not two of each.
    expect(loaded?.messages.length).toBe(2);
    expect(loaded?.messages[0]!.payload).toStrictEqual({
      kind: "user",
      text: "why?",
    });
    const ai = loaded?.messages[1]!.payload as {
      text: string;
      turnId?: string;
      retry?: {
        index: number;
        count: number;
        attempts: Array<{ turnId: string; text: string }>;
      };
    };
    // The latest attempt is shown inline...
    expect(ai.text).toBe("because B");
    expect(ai.turnId).toBe(second?.turnId);
    // ...with both attempts carried for the client pager, oldest→newest.
    expect(ai.retry?.count).toBe(2);
    expect(ai.retry?.index).toBe(2);
    expect(ai.retry?.attempts.map((a) => a.text)).toStrictEqual([
      "because A",
      "because B",
    ]);
    expect(ai.retry?.attempts.map((a) => a.turnId)).toStrictEqual([
      first?.turnId,
      second?.turnId,
    ]);
  });

  it("setTurnFeedback sets + clears 👍/👎 and surfaces it on reconstruction (#420)", () => {
    const s = store.createSession(APP);
    const r = store.recordTurn(APP, turn(s.id, "q", "a"));
    const turnId = r!.turnId;
    expect(store.setTurnFeedback(APP, s.id, turnId, "up")).toBe(true);
    let ai = store.getSession(APP, s.id)?.messages[1]!.payload as {
      feedback?: unknown;
    };
    expect(ai.feedback).toBe("up");
    expect(store.setTurnFeedback(APP, s.id, turnId, null)).toBe(true);
    ai = store.getSession(APP, s.id)?.messages[1]!.payload as {
      feedback?: unknown;
    };
    expect(ai.feedback).toBeNull();
  });

  it("setTurnFeedback returns false for a turn outside the session (#420)", () => {
    const s = store.createSession(APP);
    store.recordTurn(APP, turn(s.id, "q", "a"));
    expect(store.setTurnFeedback(APP, s.id, "no-such-turn", "down")).toBe(
      false
    );
  });

  it("findRecordedTurn returns the replayable answer for a recorded idempotency key (#420)", () => {
    const s = store.createSession(APP);
    const key = "idem-key-1";
    store.recordTurn(APP, {
      ...turn(s.id, "q", "the answer"),
      idempotencyKey: key,
    });
    const found = store.findRecordedTurn(APP, s.id, key);
    expect(found?.ok).toBe(true);
    expect(found?.finalText).toBe("the answer");
    // An unknown key (and a wrong app) both read as not-found.
    expect(store.findRecordedTurn(APP, s.id, "no-such-key")).toBeUndefined();
    expect(store.findRecordedTurn("other", s.id, key)).toBeUndefined();
  });

  it("findRecordedTurn surfaces a recorded error turn as ok:false (#420)", () => {
    const s = store.createSession(APP);
    const key = "idem-key-err";
    store.recordTurn(APP, {
      conversationId: s.id,
      userMessage: "q",
      startedAt: Date.now(),
      endedAt: Date.now() + 10,
      ok: false,
      error: "nope",
      idempotencyKey: key,
      nodes: [
        {
          kind: "step",
          text: "nope",
          isError: true,
          startedAt: Date.now(),
          endedAt: Date.now(),
        },
      ],
    });
    const found = store.findRecordedTurn(APP, s.id, key);
    expect(found?.ok).toBe(false);
    expect(found?.error).toBe("nope");
  });

  it("persists A→B→A bindings, per-runner watermarks, workspace, lock, and cascade GC", () => {
    const dir = freshVaultDir();
    const durable = new ConversationHistoryStore(workspaceFor(dir));
    const session = durable.createSession(APP);

    durable.recordTurn(APP, {
      ...turn(session.id, "ask A", "answer A"),
      adapter: { kind: "codex", sessionId: "codex-session" },
    });
    const db = journalFor(dir)();
    expect(
      plainRows(
        db
          .prepare(
            `SELECT seq FROM turns WHERE conversation_id = ? ORDER BY seq`
          )
          .all(session.id) as Array<{ seq: number }>
      )
    ).toStrictEqual([{ seq: 0 }]);
    const codexAtOne = durable.getAdapterResumeState(APP, session.id, "codex");
    expect(codexAtOne).toMatchObject({
      kind: "codex",
      sessionId: "codex-session",
      hydratedThroughSeq: 0,
    });

    durable.recordTurn(APP, {
      ...turn(session.id, "ask B", "answer B"),
      adapter: { kind: "claude-code", sessionId: "claude-session" },
    });
    expect(
      durable.getAdapterResumeState(APP, session.id, "claude-code")
    ).toMatchObject({
      sessionId: "claude-session",
      hydratedThroughSeq: 1,
    });
    expect(
      durable.getAdapterResumeState(APP, session.id, "codex")
    ).toMatchObject({
      sessionId: "codex-session",
      hydratedThroughSeq: 0,
    });
    const codexDelta = durable.getHydrationDelta(APP, session.id, 0);
    expect(codexDelta?.throughSeq).toBe(1);
    expect(
      codexDelta?.messages.map(
        (message) => (message.payload as { text?: string }).text
      )
    ).toStrictEqual(["ask B", "answer B"]);

    durable.recordTurn(APP, {
      ...turn(session.id, "back to A", "answer A2"),
      adapter: { kind: "codex", sessionId: "codex-session" },
    });
    expect(
      durable.getAdapterResumeState(APP, session.id, "codex")
    ).toMatchObject({
      hydratedThroughSeq: 2,
    });
    expect(
      durable.getAdapterResumeState(APP, session.id, "claude-code")
    ).toMatchObject({
      hydratedThroughSeq: 1,
    });

    expect(durable.acquireTurnLock(APP, session.id, "owner-a")).toBe(true);
    expect(durable.acquireTurnLock(APP, session.id, "owner-b")).toBe(false);
    durable.releaseTurnLock(APP, session.id, "owner-a");
    expect(durable.acquireTurnLock(APP, session.id, "owner-b")).toBe(true);
    durable.releaseTurnLock(APP, session.id, "owner-b");

    durable.setWorkspaceSelection(APP, session.id, "draft", [
      "/workspace/docs",
    ]);
    expect(durable.getSession(APP, session.id)?.workspace).toMatchObject({
      primaryKind: "draft",
      additionalDirectories: ["/workspace/docs"],
    });

    const bindingId = durable.getAdapterResumeState(
      APP,
      session.id,
      "codex"
    )!.bindingId!;
    durable.markAdapterBindingStale(APP, session.id, bindingId);
    durable.recordTurn(APP, {
      ...turn(session.id, "self heal A", "answer A3"),
      adapter: { kind: "codex", sessionId: "codex-session-2", hydrated: true },
    });
    expect(
      durable.getAdapterResumeState(APP, session.id, "codex")
    ).toMatchObject({
      sessionId: "codex-session-2",
      hydratedThroughSeq: 3,
    });

    expect(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count
               FROM conversation_harness_sessions
              WHERE conversation_id = ?`
          )
          .get(session.id) as { count: number }
      ).count
    ).toBe(3);
    expect(
      plainRows(
        db
          .prepare(
            `SELECT runner_kind, acp_session_id, status
             FROM conversation_harness_sessions
            WHERE conversation_id = ?
            ORDER BY created_at, acp_session_id`
          )
          .all(session.id) as Array<{
          runner_kind: string;
          acp_session_id: string;
          status: string;
        }>
      )
    ).toStrictEqual([
      {
        runner_kind: "codex",
        acp_session_id: "codex-session",
        status: "stale",
      },
      {
        runner_kind: "claude-code",
        acp_session_id: "claude-session",
        status: "warm",
      },
      {
        runner_kind: "codex",
        acp_session_id: "codex-session-2",
        status: "active",
      },
    ]);
    expect(durable.deleteSession(APP, session.id)).toBe(true);
    for (const table of [
      "conversation_harness_sessions",
      "conversation_turn_locks",
      "conversation_workspace_selection",
    ]) {
      expect(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS count FROM ${table} WHERE conversation_id = ?`
            )
            .get(session.id) as { count: number }
        ).count
      ).toBe(0);
    }
  });

  it("hydrates turn seq 0 into a binding minted before the conversation had turns", () => {
    // `seq` starts at 0, so an empty conversation's watermark must be -1. A 0
    // sentinel would read as "turn 0 already delivered" and silently drop the
    // very first exchange from the binding's next delta hydration.
    const dir = freshVaultDir();
    const durable = new ConversationHistoryStore(workspaceFor(dir));
    const session = durable.createSession(APP);
    durable.noteTurn(APP, session.id, {
      kind: "codex",
      sessionId: "codex-session",
    });
    const fresh = durable.getAdapterResumeState(APP, session.id, "codex");
    expect(fresh).toMatchObject({
      sessionId: "codex-session",
      hydratedThroughSeq: -1,
    });

    durable.recordTurn(
      APP,
      turn(session.id, "first ever question", "first ever answer")
    );
    const delta = durable.getHydrationDelta(
      APP,
      session.id,
      fresh!.hydratedThroughSeq!
    );
    expect(
      delta?.messages.map(
        (message) => (message.payload as { text?: string }).text
      )
    ).toStrictEqual(["first ever question", "first ever answer"]);
  });

  it("keeps a failed turn inside the next delta instead of advancing the watermark", () => {
    // The failed prompt never reached the model, so marking it "hydrated"
    // would erase that user message from every later handoff.
    const dir = freshVaultDir();
    const durable = new ConversationHistoryStore(workspaceFor(dir));
    const session = durable.createSession(APP);
    durable.recordTurn(APP, {
      ...turn(session.id, "ask A", "answer A"),
      adapter: { kind: "codex", sessionId: "codex-session" },
    });
    expect(
      durable.getAdapterResumeState(APP, session.id, "codex")
    ).toMatchObject({
      hydratedThroughSeq: 0,
    });

    durable.recordTurn(APP, {
      ...turn(session.id, "ask B while codex is down", ""),
      ok: false,
      error: "runner unavailable",
      finalText: undefined,
      nodes: [],
      failedAdapter: { kind: "codex", sessionId: "codex-session" },
    });
    const resume = durable.getAdapterResumeState(APP, session.id, "codex");
    expect(resume).toMatchObject({ hydratedThroughSeq: 0 });
    const delta = durable.getHydrationDelta(
      APP,
      session.id,
      resume!.hydratedThroughSeq!
    );
    expect(
      delta?.messages.map(
        (message) => (message.payload as { text?: string }).text
      )
    ).toContain("ask B while codex is down");
  });

  it("keeps one active/one warm process while A→B→C retains every runner resume handle", () => {
    const dir = freshVaultDir();
    const durable = new ConversationHistoryStore(workspaceFor(dir));
    const session = durable.createSession(APP);

    for (const [index, adapter] of [
      ["codex", "codex-a"],
      ["claude-code", "claude-b"],
      ["copilot", "copilot-c"],
    ] as const) {
      durable.recordTurn(APP, {
        ...turn(session.id, `ask ${index}`, `answer ${index}`),
        adapter: { kind: index, sessionId: adapter },
      });
    }

    const db = journalFor(dir)();
    expect(
      plainRows(
        db
          .prepare(
            `SELECT runner_kind, acp_session_id, status
             FROM conversation_harness_sessions
            WHERE conversation_id = ?
            ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'warm' THEN 1 ELSE 2 END`
          )
          .all(session.id) as Array<{
          runner_kind: string;
          acp_session_id: string;
          status: string;
        }>
      )
    ).toStrictEqual([
      { runner_kind: "copilot", acp_session_id: "copilot-c", status: "active" },
      {
        runner_kind: "claude-code",
        acp_session_id: "claude-b",
        status: "warm",
      },
      { runner_kind: "codex", acp_session_id: "codex-a", status: "cold" },
    ]);
    expect(
      durable.getAdapterResumeState(APP, session.id, "copilot")
    ).toMatchObject({
      sessionId: "copilot-c",
    });
    expect(
      durable.getAdapterResumeState(APP, session.id, "claude-code")
    ).toMatchObject({
      sessionId: "claude-b",
    });
    const codexResume = durable.getAdapterResumeState(APP, session.id, "codex");
    expect(codexResume).toMatchObject({
      sessionId: "codex-a",
      hydratedThroughSeq: 0,
    });
    const delta = durable.getHydrationDelta(
      APP,
      session.id,
      codexResume?.hydratedThroughSeq ?? -1
    );
    expect(JSON.stringify(delta?.messages)).not.toContain("ask codex");
    expect(JSON.stringify(delta?.messages)).toContain("ask claude-code");
    expect(JSON.stringify(delta?.messages)).toContain("ask copilot");

    durable.recordTurn(APP, {
      ...turn(session.id, "return to codex", "answer A2"),
      adapter: { kind: "codex", sessionId: "codex-a", hydrated: true },
    });
    expect(
      plainRows(
        db
          .prepare(
            `SELECT runner_kind, acp_session_id, status
             FROM conversation_harness_sessions
            WHERE conversation_id = ?
            ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'warm' THEN 1 ELSE 2 END`
          )
          .all(session.id) as Array<{
          runner_kind: string;
          acp_session_id: string;
          status: string;
        }>
      )
    ).toStrictEqual([
      { runner_kind: "codex", acp_session_id: "codex-a", status: "active" },
      { runner_kind: "copilot", acp_session_id: "copilot-c", status: "warm" },
      {
        runner_kind: "claude-code",
        acp_session_id: "claude-b",
        status: "cold",
      },
    ]);
  });

  it("recordTurn attachments surface on the reconstructed user message (hash/mime/sizeBytes/filename/url)", () => {
    const s = store.createSession(APP);
    store.recordTurn(APP, {
      conversationId: s.id,
      userMessage: "see attached",
      startedAt: 1_000,
      endedAt: 1_010,
      ok: true,
      finalText: "got it",
      attachments: [
        {
          hash: "a".repeat(64),
          mime: "image/png",
          sizeBytes: 1234,
          filename: "shot.png",
        },
      ],
      nodes: [
        { kind: "step", text: "got it", startedAt: 1_000, endedAt: 1_010 },
      ],
    });
    const loaded = store.getSession(APP, s.id);
    const user = loaded?.messages[0]!.payload as {
      kind: string;
      text: string;
      attachments?: Array<{
        hash: string;
        mime: string;
        sizeBytes: number;
        filename?: string;
        url: string;
      }>;
    };
    expect(user.kind).toBe("user");
    expect(user.attachments).toStrictEqual([
      {
        hash: "a".repeat(64),
        mime: "image/png",
        sizeBytes: 1234,
        filename: "shot.png",
        url: `/_centraid-conversations/apps/${APP}/blobs/${"a".repeat(64)}`,
      },
    ]);
  });

  it("recordTurn omits `attachments` from the user payload when there are none", () => {
    const s = store.createSession(APP);
    store.recordTurn(APP, turn(s.id, "no files", "ok"));
    const user = store.getSession(APP, s.id)?.messages[0]!.payload as Record<
      string,
      unknown
    >;
    expect("attachments" in user).toBe(false);
  });

  it("records agent workspace artifacts as path + hash refs without a CAS URL", () => {
    const s = store.createSession(APP);
    store.recordTurn(APP, {
      conversationId: s.id,
      userMessage: "write the report",
      startedAt: 1_000,
      endedAt: 1_010,
      ok: true,
      finalText: "done",
      nodes: [
        {
          kind: "tool",
          toolName: "write_file",
          ok: true,
          startedAt: 1_000,
          endedAt: 1_005,
          artifacts: [
            {
              hash: "b".repeat(64),
              mime: "text/markdown",
              sizeBytes: 42,
              filename: "report.md",
              source: "agent",
              workspacePath: "/workspace/report.md",
            },
          ],
        },
        { kind: "step", text: "done", startedAt: 1_005, endedAt: 1_010 },
      ],
    });
    const tool = store.getSession(APP, s.id)?.messages[1]?.payload as {
      artifacts?: Array<Record<string, unknown>>;
    };
    expect(tool.artifacts).toStrictEqual([
      {
        hash: "b".repeat(64),
        mime: "text/markdown",
        sizeBytes: 42,
        filename: "report.md",
        source: "agent",
        workspacePath: "/workspace/report.md",
      },
    ]);
  });

  it("recordTurn preserves order across multiple turns", () => {
    const s = store.createSession(APP);
    store.recordTurn(APP, turn(s.id, "q1", "a1", 1_000));
    store.recordTurn(APP, turn(s.id, "q2", "a2", 2_000));
    const loaded = store.getSession(APP, s.id);
    const texts = (loaded?.messages ?? []).map(
      (m) => (m.payload as { text?: string }).text
    );
    expect(texts).toStrictEqual(["q1", "a1", "q2", "a2"]);
  });

  it("recordTurn defaults the run kind to chat; honors an explicit build kind (#181)", () => {
    const appsDir = freshVaultDir();
    const local = new ConversationHistoryStore(workspaceFor(appsDir));
    const chat = local.createSession(APP);
    const build = local.createSession(APP);
    local.recordTurn(APP, turn(chat.id, "data q", "data a", 1_000));
    local.recordTurn(APP, {
      ...turn(build.id, "tweak ui", "done", 2_000),
      kind: "build",
    });

    // The kind moved UP onto the conversation (issue #190): a builder turn
    // sets its thread to `kind: 'build'`; a data chat stays `'chat'`. Read the
    // persisted conversations back through a fresh store on the same file.
    const conv = new ConversationStore(journalFor(appsDir));
    expect(conv.getConversation(chat.id)?.kind).toBe("chat");
    expect(conv.getConversation(build.id)?.kind).toBe("build");

    // Transcript reconstruction is kind-agnostic — a build turn round-trips
    // exactly like a chat turn.
    const loaded = local.getSession(APP, build.id);
    expect(loaded?.messages[0]!.payload).toStrictEqual({
      kind: "user",
      text: "tweak ui",
    });
    expect(loaded?.messages[1]!.payload).toMatchObject({
      kind: "ai",
      text: "done",
    });
  });

  it("recordTurn reconstructs tool nodes interleaved before the assistant reply", () => {
    const s = store.createSession(APP);
    const t = 5_000;
    store.recordTurn(APP, {
      conversationId: s.id,
      userMessage: "count rows",
      startedAt: t,
      endedAt: t + 50,
      ok: true,
      finalText: "there is 1 row",
      nodes: [
        {
          kind: "tool",
          toolName: "vault_sql",
          sql: "SELECT COUNT(*) FROM x",
          ok: true,
          result: [{ n: 1 }],
          appId: "todos",
          startedAt: t,
          endedAt: t + 20,
        },
        {
          kind: "step",
          text: "there is 1 row",
          startedAt: t + 20,
          endedAt: t + 50,
        },
      ],
    });
    const loaded = store.getSession(APP, s.id);
    expect(loaded?.messages.length).toBe(3);
    const tool = loaded?.messages[1]!.payload as Record<string, unknown>;
    expect(tool.kind).toBe("tool");
    expect(tool.tool).toBe("vault_sql");
    expect(tool.sql).toBe("SELECT COUNT(*) FROM x");
    expect(tool.state).toBe("ok");
    expect(tool.result).toStrictEqual([{ n: 1 }]);
    expect(tool.id).toBeTypeOf("string");
    expect(loaded?.messages[2]!.payload).toMatchObject({
      kind: "ai",
      text: "there is 1 row",
    });
  });

  it("recordTurn marks a failed tool node as state=error", () => {
    const s = store.createSession(APP);
    const t = 6_000;
    store.recordTurn(APP, {
      conversationId: s.id,
      userMessage: "break it",
      startedAt: t,
      endedAt: t + 30,
      ok: true,
      nodes: [
        {
          kind: "tool",
          toolName: "vault_invoke",
          ok: false,
          errorText: "no such table",
          startedAt: t,
          endedAt: t + 30,
        },
      ],
    });
    const tool = store.getSession(APP, s.id)?.messages[1]!.payload as Record<
      string,
      unknown
    >;
    expect(tool.state).toBe("error");
    expect(tool.errorText).toBe("no such table");
  });

  it("recordTurn folds a turn error as an error ai message", () => {
    const s = store.createSession(APP);
    const t = 7_000;
    store.recordTurn(APP, {
      conversationId: s.id,
      userMessage: "go",
      startedAt: t,
      endedAt: t + 5,
      ok: false,
      error: "runner crashed",
      nodes: [
        {
          kind: "step",
          text: "runner crashed",
          isError: true,
          startedAt: t,
          endedAt: t + 5,
        },
      ],
    });
    const ai = store.getSession(APP, s.id)?.messages[1]!.payload as Record<
      string,
      unknown
    >;
    expect(ai).toMatchObject({
      kind: "ai",
      text: "runner crashed",
      error: true,
    });
  });

  it("recordTurn derives the title from the first user message if empty", () => {
    const s = store.createSession(APP, "");
    store.recordTurn(APP, turn(s.id, "Add a daily standup", "ok"));
    expect(store.listSessions(APP)[0]!.title).toBe("Add a daily standup");
  });

  it("recordTurn does not overwrite a non-empty title", () => {
    const s = store.createSession(APP, "Pinned name");
    store.recordTurn(APP, turn(s.id, "something", "ok"));
    expect(store.getSessionMeta(APP, s.id)?.title).toBe("Pinned name");
  });

  it("recordTurn returns undefined for an unknown session", () => {
    expect(
      store.recordTurn(APP, turn("not-a-real-id", "hi", "x"))
    ).toBeUndefined();
  });

  it("messageCount counts the reconstructed transcript length", () => {
    const s = store.createSession(APP);
    store.recordTurn(APP, turn(s.id, "q", "a"));
    expect(store.listSessions(APP)[0]!.messageCount).toBe(2);
    expect(store.getSessionMeta(APP, s.id)?.messageCount).toBe(2);
  });

  it("renameSession updates title and bumps updatedAt", () => {
    const s = store.createSession(APP, "old");
    const updated = store.renameSession(APP, s.id, "new");
    expect(updated?.title).toBe("new");
    expect((updated?.updatedAt ?? 0) >= s.updatedAt).toBeTruthy();
  });

  it("renameSession returns undefined for unknown id", () => {
    expect(store.renameSession(APP, "nope", "x")).toBeUndefined();
  });

  it("deleteSession cascades to the session runs", () => {
    const s = store.createSession(APP);
    store.recordTurn(APP, turn(s.id, "doomed", "x"));
    expect(store.deleteSession(APP, s.id)).toBe(true);
    expect(store.getSession(APP, s.id)).toBeUndefined();
  });

  it("listSessions orders by updatedAt desc", async () => {
    const a = store.createSession(APP, "A");
    await new Promise((resolve) => {
      setTimeout(resolve, 4);
    });
    const b = store.createSession(APP, "B");
    const list = store.listSessions(APP);
    expect(list[0]!.id).toBe(b.id);
    expect(list[1]!.id).toBe(a.id);
  });

  it("createSession persists and round-trips the row", () => {
    const s = store.createSession(APP, "shell chat");
    expect(store.getSession(APP, s.id)?.title).toBe("shell chat");
  });

  it("noteTurn bumps turn_count and persists the adapter columns", () => {
    const s = store.createSession(APP);
    expect(s.turnCount).toBe(0);
    expect(s.adapterKind).toBeNull();

    const after1 = store.noteTurn(APP, s.id, {
      kind: "codex",
      sessionId: "cx-1",
    });
    expect(after1?.turnCount).toBe(1);
    expect(after1?.adapterKind).toBe("codex");
    expect(after1?.adapterSessionId).toBe("cx-1");

    // Adapter omitted — counters move, adapter columns stay.
    const after2 = store.noteTurn(APP, s.id);
    expect(after2?.turnCount).toBe(2);
    expect(after2?.adapterKind).toBe("codex");
    expect(after2?.adapterSessionId).toBe("cx-1");

    // Adapter present but no sessionId — kind updates, session id is kept.
    const after3 = store.noteTurn(APP, s.id, { kind: "claude-code" });
    expect(after3?.turnCount).toBe(3);
    expect(after3?.adapterKind).toBe("claude-code");
    expect(after3?.adapterSessionId).toBe("cx-1");
  });

  it("noteTurn returns undefined for an unknown session", () => {
    expect(store.noteTurn(APP, "not-a-real-id")).toBeUndefined();
  });

  it("getSessionMeta returns meta without the transcript", () => {
    const s = store.createSession(APP);
    store.recordTurn(APP, turn(s.id, "hi", "yo"));
    const meta = store.getSessionMeta(APP, s.id);
    expect(meta?.id).toBe(s.id);
    expect(meta?.messageCount).toBe(2);
    expect(
      (meta as unknown as { messages?: unknown }).messages
    ).toBeUndefined();
  });
});

describe("ConversationHistoryStore per-app scoping", () => {
  it("isolates sessions and lookups per app", () => {
    const store = new ConversationHistoryStore(
      workspaceFor(freshVaultDir("todos", "habits"))
    );
    const t = store.createSession("todos", "todos-1");
    store.createSession("habits", "habits-1");
    store.createSession("habits", "habits-2");
    expect(store.listSessions("todos").map((s) => s.title)).toStrictEqual([
      "todos-1",
    ]);
    expect(store.listSessions("habits")).toHaveLength(2);
    // A session id is only found under its owning app.
    expect(store.getSession("todos", t.id)).toBeTruthy();
    expect(store.getSession("habits", t.id)).toBeUndefined();
  });
});

describe("ConversationHistoryStore per-user scoping", () => {
  // Two stores on the same vault's journal.db, different owner identities.
  function pair(): {
    alice: ConversationHistoryStore;
    bob: ConversationHistoryStore;
  } {
    const appsDir = freshVaultDir();
    return {
      alice: new ConversationHistoryStore(workspaceFor(appsDir, "alice")),
      bob: new ConversationHistoryStore(workspaceFor(appsDir, "bob")),
    };
  }

  it("createSession stamps the current user id on the row", () => {
    const store = newStore("alice");
    const s = store.createSession(APP);
    expect(s.userId).toBe("alice");
    expect(store.getSession(APP, s.id)?.userId).toBe("alice");
  });

  it("listSessions does not return another user's sessions", () => {
    const { alice, bob } = pair();
    alice.createSession(APP, "alice-1");
    alice.createSession(APP, "alice-2");
    bob.createSession(APP, "bob-1");

    const aliceList = alice.listSessions(APP);
    expect(aliceList).toHaveLength(2);
    expect(aliceList.every((s) => s.userId === "alice")).toBeTruthy();

    const bobList = bob.listSessions(APP);
    expect(bobList).toHaveLength(1);
    expect(bobList[0]!.title).toBe("bob-1");
  });

  it("getSession returns undefined for another user's session id", () => {
    const { alice, bob } = pair();
    const aliceSession = alice.createSession(APP);
    expect(bob.getSession(APP, aliceSession.id)).toBeUndefined();
  });

  it("recordTurn refuses to write into another user's session", () => {
    const { alice, bob } = pair();
    const aliceSession = alice.createSession(APP);
    expect(
      bob.recordTurn(APP, turn(aliceSession.id, "hi", "x"))
    ).toBeUndefined();
    expect(alice.getSession(APP, aliceSession.id)?.messages.length).toBe(0);
  });

  it("renameSession + deleteSession can't touch another user's session", () => {
    const { alice, bob } = pair();
    const aliceSession = alice.createSession(APP, "mine");
    expect(bob.renameSession(APP, aliceSession.id, "stolen")).toBeUndefined();
    expect(bob.deleteSession(APP, aliceSession.id)).toBe(false);
    expect(alice.getSession(APP, aliceSession.id)?.title).toBe("mine");
  });
});

describe("ConversationHistoryStore data persistence", () => {
  it("a second ConversationHistoryStore on the same app sees the first one's writes", () => {
    const appsDir = freshVaultDir();
    const first = new ConversationHistoryStore(workspaceFor(appsDir));
    const s = first.createSession(APP, "kept");
    first.recordTurn(APP, turn(s.id, "hello", "world"));

    const second = new ConversationHistoryStore(workspaceFor(appsDir));
    const loaded = second.getSession(APP, s.id);
    expect(loaded?.title).toBe("kept");
    expect(loaded?.messages.length).toBe(2);
  });
});

// HTTP route dispatcher — minimal fake req/res, no real port bound.
interface FakeReq {
  url: string;
  method: string;
  [Symbol.asyncIterator]: () => AsyncIterableIterator<Buffer>;
}
interface FakeRes {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  writeHead: (status: number, headers: Record<string, string>) => FakeRes;
  end: (text?: string) => void;
  readonly body: unknown;
}

function makeReq(method: string, url: string, body?: unknown): FakeReq {
  const bodyJson = body === undefined ? undefined : JSON.stringify(body);
  return {
    method,
    url,
    async *[Symbol.asyncIterator](): AsyncIterableIterator<Buffer> {
      if (bodyJson !== undefined) yield Buffer.from(bodyJson, "utf8");
    },
  };
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    status: 0,
    headers: {},
    bodyText: "",
    writeHead(status, headers): FakeRes {
      res.status = status;
      res.headers = headers;
      return res;
    },
    end(text?: string): void {
      if (text) res.bodyText = text;
    },
    get body(): unknown {
      return res.bodyText ? (JSON.parse(res.bodyText) as unknown) : null;
    },
  };
  return res;
}

function call(
  handler: ReturnType<typeof makeConversationRouteHandler>,
  method: string,
  url: string,
  body?: unknown
): Promise<FakeRes> {
  const req = makeReq(method, url, body) as unknown as IncomingMessage;
  const res = makeRes();
  return handler(req, res as unknown as ServerResponse).then(() => res);
}

describe(makeConversationRouteHandler, () => {
  const BASE = `/_centraid-conversations/apps/${APP}/sessions`;
  let handler: ReturnType<typeof makeConversationRouteHandler>;
  let store: ConversationHistoryStore;
  beforeEach(() => {
    store = newStore();
    handler = makeConversationRouteHandler(() => store);
  });

  it("POST sessions creates a session", async () => {
    const res = await call(handler, "POST", BASE, {});
    expect(res.status).toBe(200);
    expect(
      (
        res.body as {
          id: string;
        }
      ).id.length
    ).toBeGreaterThan(0);
  });

  it("POST sessions honors the title", async () => {
    const res = await call(handler, "POST", BASE, { title: "named" });
    expect(res.status).toBe(200);
    expect((res.body as { title: string }).title).toBe("named");
  });

  it("round-trips create → list → load → rename → delete", async () => {
    const created = await call(handler, "POST", BASE, { title: "hi" });
    expect(created.status).toBe(200);
    const id = (created.body as { id: string }).id;

    const listed = await call(handler, "GET", BASE);
    expect(listed.status).toBe(200);
    expect((listed.body as { sessions: unknown[] }).sessions).toHaveLength(1);

    const loaded = await call(handler, "GET", `${BASE}/${id}`);
    expect(loaded.status).toBe(200);
    expect((loaded.body as { messages: unknown[] }).messages).toStrictEqual([]);

    const renamed = await call(handler, "PATCH", `${BASE}/${id}`, {
      title: "renamed",
    });
    expect(renamed.status).toBe(200);
    expect((renamed.body as { title: string }).title).toBe("renamed");

    const deleted = await call(handler, "DELETE", `${BASE}/${id}`);
    expect(deleted.status).toBe(200);
    expect((deleted.body as { ok: boolean }).ok).toBe(true);
  });

  it("404s loading a missing session", async () => {
    const res = await call(handler, "GET", `${BASE}/no-such-id`);
    expect(res.status).toBe(404);
  });

  it("PATCH .../turns/<turnId>/feedback sets and clears feedback (#420)", async () => {
    const created = await call(handler, "POST", BASE, {});
    const id = (created.body as { id: string }).id;
    const rec = store.recordTurn(APP, turn(id, "q", "a"));
    const turnId = rec!.turnId;
    const up = await call(
      handler,
      "PATCH",
      `${BASE}/${id}/turns/${turnId}/feedback`,
      {
        feedback: "up",
      }
    );
    expect(up.status).toBe(200);
    expect((up.body as { feedback: string }).feedback).toBe("up");
    const loaded = await call(handler, "GET", `${BASE}/${id}`);
    const ai = (
      loaded.body as { messages: Array<{ payload: { feedback?: unknown } }> }
    ).messages[1]!.payload;
    expect(ai.feedback).toBe("up");
    // An unknown value clears it back to null.
    const clear = await call(
      handler,
      "PATCH",
      `${BASE}/${id}/turns/${turnId}/feedback`,
      {
        feedback: "bogus",
      }
    );
    expect((clear.body as { feedback: unknown }).feedback).toBeNull();
  });

  it("PATCH feedback 404s for an unknown turn (#420)", async () => {
    const created = await call(handler, "POST", BASE, {});
    const id = (created.body as { id: string }).id;
    const res = await call(
      handler,
      "PATCH",
      `${BASE}/${id}/turns/nope/feedback`,
      {
        feedback: "up",
      }
    );
    expect(res.status).toBe(404);
  });

  it("GET sessions/search returns FTS hits with a snippet (#420)", async () => {
    const created = await call(handler, "POST", BASE, {
      title: "Budget review",
    });
    const id = (created.body as { id: string }).id;
    store.recordTurn(APP, turn(id, "plan the quarterly budget", "sure"));
    const res = await call(handler, "GET", `${BASE}/search?q=quarterly`);
    expect(res.status).toBe(200);
    const results = (
      res.body as { results: Array<{ id: string; snippet: string }> }
    ).results;
    expect(results.map((r) => r.id)).toStrictEqual([id]);
    expect(results[0]!.snippet).toContain("⟦");
    // A blank query yields no results, not an error.
    const empty = await call(handler, "GET", `${BASE}/search?q=`);
    expect((empty.body as { results: unknown[] }).results).toStrictEqual([]);
  });

  it("PATCH pins / archives a session and list ordering + flags reflect it (#420)", async () => {
    const a = (await call(handler, "POST", BASE, { title: "Alpha" })).body as {
      id: string;
    };
    const b = (await call(handler, "POST", BASE, { title: "Beta" })).body as {
      id: string;
    };
    const pinned = await call(handler, "PATCH", `${BASE}/${a.id}`, {
      pinned: true,
    });
    expect(pinned.status).toBe(200);
    expect((pinned.body as { pinned: boolean }).pinned).toBe(true);
    const list = (await call(handler, "GET", BASE)).body as {
      sessions: Array<{ id: string; pinned: boolean; archived: boolean }>;
    };
    // Pinned a sorts before b regardless of recency.
    expect(list.sessions[0]!.id).toBe(a.id);
    expect(list.sessions[0]!.pinned).toBe(true);
    const archived = await call(handler, "PATCH", `${BASE}/${b.id}`, {
      archived: true,
    });
    expect((archived.body as { archived: boolean }).archived).toBe(true);
    // Archived b drops out of search.
    store.recordTurn(APP, turn(b.id, "beta needle text", "ok"));
    const res = await call(handler, "GET", `${BASE}/search?q=needle`);
    expect((res.body as { results: unknown[] }).results).toStrictEqual([]);
  });

  it("405s on unsupported method", async () => {
    const res = await call(handler, "PUT", BASE);
    expect(res.status).toBe(405);
  });

  it("404s on a malformed route (no /apps/<appId> segment)", async () => {
    const res = await call(handler, "GET", "/_centraid-conversations/sessions");
    expect(res.status).toBe(404);
  });

  it("returns false (delegates) for URLs outside the prefix", async () => {
    const req = makeReq("GET", "/something-else") as unknown as IncomingMessage;
    const res = makeRes();
    const handled = await handler(req, res as unknown as ServerResponse);
    expect(handled).toBe(false);
    expect(res.status).toBe(0); // never wrote anything
  });
});
