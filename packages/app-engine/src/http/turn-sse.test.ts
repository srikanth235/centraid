/**
 * Direct unit tests for the SSE turn driver helpers (issue #545 B4).
 * Pure attachment parsing / lock serialization — no live HTTP or runner.
 */

import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { ConversationHistoryStore } from "../conversation/history.js";
import type {
  ConversationRunner,
  TurnResumePlan,
} from "../conversation/runner.js";
import { makeJournalDbProvider } from "../stores/gateway-db.js";
import {
  driveTurnOverSse,
  parseTurnAttachmentRefs,
  resolveTurnAttachments,
  validateTurnAttachmentRefs,
  withConversationLock,
} from "./turn-sse.js";

const HASH = "ab".repeat(32);

describe(parseTurnAttachmentRefs, () => {
  it("returns [] for non-arrays and drops malformed entries", () => {
    expect(parseTurnAttachmentRefs(undefined)).toStrictEqual([]);
    expect(parseTurnAttachmentRefs(null)).toStrictEqual([]);
    expect(parseTurnAttachmentRefs("x")).toStrictEqual([]);
    expect(
      parseTurnAttachmentRefs([{ hash: "short", mime: "image/png" }])
    ).toStrictEqual([]);
    expect(parseTurnAttachmentRefs([{ hash: HASH }])).toStrictEqual([]); // missing mime
    expect(parseTurnAttachmentRefs([null, 1, {}])).toStrictEqual([]);
  });

  it("keeps only 64-hex hash + mime (filename/size optional passthrough shape)", () => {
    const refs = parseTurnAttachmentRefs([
      { hash: HASH, mime: "image/png", filename: "a.png", sizeBytes: 12 },
      { hash: "cd".repeat(32), mime: "text/plain" },
      { hash: HASH.toUpperCase(), mime: "image/png" }, // uppercase rejected
    ]);
    expect(refs).toStrictEqual([
      { hash: HASH, mime: "image/png", filename: "a.png", sizeBytes: 12 },
      { hash: "cd".repeat(32), mime: "text/plain" },
    ]);
  });
});

describe(resolveTurnAttachments, () => {
  it("returns [] when store missing or refs empty", () => {
    expect(
      resolveTurnAttachments(undefined, "app", [{ hash: HASH, mime: "x" }])
    ).toStrictEqual([]);
    expect(
      resolveTurnAttachments(
        { blobPathFor: () => "/never" } as never,
        "app",
        []
      )
    ).toStrictEqual([]);
  });

  it("maps only real, size-matched CAS refs through conversationStore.blobPathFor", async () => {
    const dir = await tempDir("centraid-turn-attachments-");
    await fs.writeFile(path.join(dir, HASH), "png");
    await fs.writeFile(path.join(dir, "cd".repeat(32)), "text");
    const store = {
      blobPathFor: (_appId: string, hash: string) => path.join(dir, hash),
    };
    const refs = [
      { hash: HASH, mime: "image/png", filename: "p.png", sizeBytes: 3 },
      { hash: "cd".repeat(32), mime: "text/plain", sizeBytes: 4 },
      { hash: "ef".repeat(32), mime: "text/plain", sizeBytes: 1 },
      { hash: HASH, mime: "image/png", filename: "wrong.png", sizeBytes: 99 },
    ];
    expect(
      validateTurnAttachmentRefs(store as never, "notes", refs)
    ).toStrictEqual(refs.slice(0, 2));
    const out = resolveTurnAttachments(store as never, "notes", refs);
    expect(out).toStrictEqual([
      { path: path.join(dir, HASH), mime: "image/png", filename: "p.png" },
      { path: path.join(dir, "cd".repeat(32)), mime: "text/plain" },
    ]);
  });
});

describe(withConversationLock, () => {
  it("serializes work on the same (appId, conversationId) key", async () => {
    const locks = new Map<string, Promise<void>>();
    const order: number[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = () => resolve();
    });

    const p1 = withConversationLock(locks, "app", "c1", async () => {
      order.push(1);
      await firstGate;
      order.push(2);
      return "a";
    });
    const p2 = withConversationLock(locks, "app", "c1", async () => {
      order.push(3);
      return "b";
    });
    // Same conversation — p2 must wait until p1 finishes.
    await Promise.resolve();
    expect(order).toStrictEqual([1]);
    releaseFirst();
    await expect(Promise.all([p1, p2])).resolves.toStrictEqual(["a", "b"]);
    expect(order).toStrictEqual([1, 2, 3]);
    // Lock entry is cleared once both settle.
    expect(locks.size).toBe(0);
  });

  it("does not block distinct conversation keys", async () => {
    const locks = new Map<string, Promise<void>>();
    const started: string[] = [];
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = () => resolve();
    });

    const a = withConversationLock(locks, "app", "cA", async () => {
      started.push("a");
      await gateA;
      return 1;
    });
    const b = withConversationLock(locks, "app", "cB", async () => {
      started.push("b");
      return 2;
    });
    await Promise.resolve();
    expect(started.sort()).toStrictEqual(["a", "b"]);
    releaseA();
    await expect(Promise.all([a, b])).resolves.toStrictEqual([1, 2]);
  });
});

/** A minimal req/res pair for the SSE driver — no live socket. */
function harness(): { req: IncomingMessage; res: ServerResponse } {
  const requestListeners = new Map<string, (...args: unknown[]) => void>();
  const req = {
    on(event: string, listener: (...args: unknown[]) => void) {
      requestListeners.set(event, listener);
      return this;
    },
    off(event: string, listener: (...args: unknown[]) => void) {
      if (requestListeners.get(event) === listener)
        requestListeners.delete(event);
      return this;
    },
  } as unknown as IncomingMessage;
  const res = {
    writableEnded: false,
    writeHead: vi.fn<ServerResponse["writeHead"]>(),
    write: vi.fn<ServerResponse["write"]>(() => true),
    end(this: { writableEnded: boolean }) {
      this.writableEnded = true;
      return this;
    },
  } as unknown as ServerResponse;
  return { req, res };
}

describe("driveTurnOverSse recovery hydration", () => {
  it("includes the sequence-zero turn when an existing harness handle self-heals", async () => {
    const dir = await tempDir("centraid-turn-recovery-");
    const appsDir = path.join(dir, "apps");
    const appDir = path.join(appsDir, "notes");
    const journalDbFile = path.join(dir, "journal.db");
    const runnerSessionDir = path.join(dir, "runner-sessions");
    await fs.mkdir(appDir, { recursive: true });
    const journal = makeJournalDbProvider(journalDbFile);
    const history = new ConversationHistoryStore(() => ({
      vaultId: "vault-test",
      ownerPartyId: "owner",
      appsDir,
      journal,
      journalDbFile,
      runnerSessionDir,
    }));
    const conversation = history.createSession("notes");
    history.recordTurn("notes", {
      conversationId: conversation.id,
      userMessage: "sequence-zero question",
      startedAt: 1,
      endedAt: 2,
      ok: true,
      finalText: "sequence-zero answer",
      nodes: [
        {
          kind: "step",
          text: "sequence-zero answer",
          startedAt: 1,
          endedAt: 2,
        },
      ],
      bindings: [{ kind: "codex", sessionId: "codex-session", ok: true }],
    });

    // Read the plan DURING the turn: that is when the ladder resolves it, and
    // before this turn's own rows land in the ledger.
    let codex: TurnResumePlan | undefined;
    const runner: ConversationRunner = {
      async run(input) {
        // Stand in for the spine: ask the owner for this rung's plan, then
        // report back what the rung drove.
        codex = input.harnessSessions?.plan("codex");
        input.onEvent({ type: "final", text: "next answer" });
        input.harnessSessions?.observe("codex", {
          harnessKind: "codex",
          sessionId: "codex-session",
        });
        return { harnessKind: "codex", adapterSessionId: "codex-session" };
      },
    };
    await driveTurnOverSse({
      ...harness(),
      appId: "notes",
      conversationId: conversation.id,
      message: "next question",
      dataDir: appDir,
      extraSystemPrompt: "app context",
      runner,
      harnessKind: "codex",
      conversationStore: history,
      conversationRunnerSessionDir: runnerSessionDir,
      conversationLocks: new Map(),
      banner: "test",
    });

    // Resume + hydration are planned PER RUNG now, so the driver hands the
    // runner a planner instead of one precomputed plan; the codex rung's own
    // plan is what must carry the seq-zero recovery context.
    expect(codex?.sessionId).toBe("codex-session");
    expect(codex?.hydrationContext).toBeUndefined();
    expect(codex?.recoveryHydrationContext).toMatchObject({ includedTurns: 1 });
    expect(codex?.recoveryHydrationContext?.prompt).toContain(
      "sequence-zero question"
    );
    expect(codex?.recoveryHydrationContext?.prompt).toContain(
      "sequence-zero answer"
    );
  });

  it("plans a failover rung against its OWN binding and the full ledger", async () => {
    // Regression for the review blocker: the ladder rung the runner actually
    // reaches may be a provider the route never targeted. Planned once against
    // the primary target, a fallback rung started with no session id AND no
    // hydration — the entire conversation silently lost.
    const dir = await tempDir("centraid-turn-perrung-");
    const appsDir = path.join(dir, "apps");
    const appDir = path.join(appsDir, "notes");
    const journalDbFile = path.join(dir, "journal.db");
    const runnerSessionDir = path.join(dir, "runner-sessions");
    await fs.mkdir(appDir, { recursive: true });
    const journal = makeJournalDbProvider(journalDbFile);
    const history = new ConversationHistoryStore(() => ({
      vaultId: "vault-test",
      ownerPartyId: "owner",
      appsDir,
      journal,
      journalDbFile,
      runnerSessionDir,
    }));
    const conversation = history.createSession("notes");
    history.recordTurn("notes", {
      conversationId: conversation.id,
      userMessage: "earlier question",
      startedAt: 1,
      endedAt: 2,
      ok: true,
      finalText: "earlier answer",
      nodes: [
        { kind: "step", text: "earlier answer", startedAt: 1, endedAt: 2 },
      ],
      bindings: [{ kind: "codex", sessionId: "codex-session", ok: true }],
    });

    // Plans must be read DURING the turn — that is when the ladder resolves
    // them, and before this turn lands in the ledger.
    let codex: TurnResumePlan | undefined;
    let claude: TurnResumePlan | undefined;
    const runner: ConversationRunner = {
      async run(input) {
        codex = input.harnessSessions?.plan("codex");
        claude = input.harnessSessions?.plan("claude-code");
        input.onEvent({ type: "final", text: "ok" });
        input.harnessSessions?.observe("claude-code", {
          harnessKind: "claude-code",
        });
        return { harnessKind: "claude-code" };
      },
    };
    await driveTurnOverSse({
      ...harness(),
      appId: "notes",
      conversationId: conversation.id,
      message: "next question",
      dataDir: appDir,
      extraSystemPrompt: "app context",
      runner,
      harnessKind: "codex",
      conversationStore: history,
      conversationRunnerSessionDir: runnerSessionDir,
      conversationLocks: new Map(),
      banner: "test",
    });

    // codex owns the binding: watermark is at seq 0, so no delta to replay.
    expect(codex?.sessionId).toBe("codex-session");
    expect(codex?.hydrationContext).toBeUndefined();
    // claude-code has never seen this conversation: no session id, and the
    // FULL ledger as its hydration — not codex's empty delta.
    expect(claude?.sessionId).toBeUndefined();
    expect(claude?.hydrationContext?.includedTurns).toBe(1);
    expect(claude?.hydrationContext?.prompt).toContain("earlier question");
    expect(claude?.hydrationContext?.prompt).toContain("earlier answer");
  });

  it("retires a binding whose resume handle the adapter had to abandon", async () => {
    const dir = await tempDir("centraid-turn-stale-");
    const appsDir = path.join(dir, "apps");
    const appDir = path.join(appsDir, "notes");
    const journalDbFile = path.join(dir, "journal.db");
    const runnerSessionDir = path.join(dir, "runner-sessions");
    await fs.mkdir(appDir, { recursive: true });
    const journal = makeJournalDbProvider(journalDbFile);
    const history = new ConversationHistoryStore(() => ({
      vaultId: "vault-test",
      ownerPartyId: "owner",
      appsDir,
      journal,
      journalDbFile,
      runnerSessionDir,
    }));
    const conversation = history.createSession("notes");
    history.recordTurn("notes", {
      conversationId: conversation.id,
      userMessage: "earlier question",
      startedAt: 1,
      endedAt: 2,
      ok: true,
      finalText: "earlier answer",
      nodes: [
        { kind: "step", text: "earlier answer", startedAt: 1, endedAt: 2 },
      ],
      bindings: [{ kind: "codex", sessionId: "dead-session", ok: true }],
    });
    const deadBinding = history.getAdapterResumeState(
      "notes",
      conversation.id,
      "codex"
    )!.bindingId;

    // The adapter rejects the handle we passed and self-heals onto a fresh
    // session, but the turn itself fails — so nothing else retires the row.
    const runner: ConversationRunner = {
      async run(input) {
        input.harnessSessions?.plan("codex");
        input.onEvent({ type: "error", message: "model overloaded" });
        input.harnessSessions?.observeFailure("codex", {
          harnessKind: "codex",
          hydrated: true,
          hydrationKind: "recovery",
        });
        return {
          harnessKind: "codex",
          hydrated: true,
          hydrationKind: "recovery",
        };
      },
    };
    await driveTurnOverSse({
      ...harness(),
      appId: "notes",
      conversationId: conversation.id,
      message: "next question",
      dataDir: appDir,
      extraSystemPrompt: "app context",
      runner,
      harnessKind: "codex",
      conversationStore: history,
      conversationRunnerSessionDir: runnerSessionDir,
      conversationLocks: new Map(),
      banner: "test",
    });

    expect(deadBinding).toBeDefined();
    // The dead handle is gone, so the next turn never re-offers it.
    expect(
      history.getAdapterResumeState("notes", conversation.id, "codex")
    ).toBeUndefined();
  });

  it("skips a directory location and surfaces an oversize workspace file", async () => {
    const dir = await tempDir("centraid-turn-artifacts-");
    const appsDir = path.join(dir, "apps");
    const appDir = path.join(appsDir, "notes");
    const journalDbFile = path.join(dir, "journal.db");
    const runnerSessionDir = path.join(dir, "runner-sessions");
    await fs.mkdir(path.join(appDir, "subdir"), { recursive: true });
    const huge = path.join(appDir, "huge.bin");
    const handle = await fs.open(huge, "w");
    await handle.truncate(26 * 1024 * 1024); // sparse — over the 25 MiB cap
    await handle.close();
    const journal = makeJournalDbProvider(journalDbFile);
    const history = new ConversationHistoryStore(() => ({
      vaultId: "vault-test",
      ownerPartyId: "owner",
      appsDir,
      journal,
      journalDbFile,
      runnerSessionDir,
    }));
    const conversation = history.createSession("notes");

    const runner: ConversationRunner = {
      async run(input) {
        input.onEvent({
          type: "tool.start",
          toolCallId: "t1",
          toolName: "write",
        });
        input.onEvent({
          type: "tool.result",
          toolCallId: "t1",
          toolName: "write",
          ok: true,
          locations: [{ path: path.join(appDir, "subdir") }, { path: huge }],
        });
        input.onEvent({ type: "final", text: "done" });
        return { harnessKind: "codex" };
      },
    };
    await driveTurnOverSse({
      ...harness(),
      appId: "notes",
      conversationId: conversation.id,
      message: "write it",
      dataDir: appDir,
      extraSystemPrompt: "app context",
      runner,
      harnessKind: "codex",
      conversationStore: history,
      conversationRunnerSessionDir: runnerSessionDir,
      conversationLocks: new Map(),
      banner: "test",
    });

    const messages = history.getSession("notes", conversation.id)!.messages;
    // The directory is skipped silently; the oversize file is a real dropped
    // artifact, so it is surfaced rather than swallowed.
    const tool = messages.find(
      (m) => (m.payload as { kind: string }).kind === "tool"
    )!;
    expect(
      (tool.payload as { artifacts?: unknown[] }).artifacts
    ).toBeUndefined();
    const notice = messages.find(
      (m) => (m.payload as { kind: string }).kind === "notice"
    )!;
    expect((notice.payload as { text?: string }).text).toContain("huge.bin");
    expect((notice.payload as { text?: string }).text).toContain("25 MiB cap");
  });
});
