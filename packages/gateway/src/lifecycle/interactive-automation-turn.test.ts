import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ConversationStore, makeJournalDbProvider } from "@centraid/app-engine";
import type {
  AutomationTurnStreamEvent,
  ConversationRunner,
  ConversationTurnInput,
  TurnStreamEvent,
} from "@centraid/app-engine";
import { validateManifest } from "@centraid/automation";
import type { Row as AutomationRow } from "@centraid/automation";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { runInteractiveAutomationTurn } from "./interactive-automation-turn.js";

const dirs: string[] = [];
describe("interactive-automation-turn suite", () => {
  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

  function row(dir: string): AutomationRow {
    const manifest = validateManifest({
      name: "Daily brief",
      version: "0.1.0",
      enabled: true,
      prompt: "Summarize important account changes.",
      triggers: [],
      requires: { harness: "codex", model: "gpt-test" },
      connections: [
        { connectionId: "gmail-work", kind: "pull.gmail", label: "Work" },
      ],
      vault: {
        purpose: "dpv:ServiceProvision",
        scopes: [{ schema: "core", table: "message", verbs: "read" }],
      },
      history: { keep: { count: 100 } },
      generated: { by: "test", at: "2026-07-25T00:00:00.000Z" },
    });
    return {
      id: "main",
      dir,
      name: manifest.name,
      triggers: manifest.triggers,
      enabled: manifest.enabled,
      ownerApp: "brief",
      ref: "brief/main",
      manifest,
    };
  }

  function seed(journalDbFile: string, withHandle: boolean): void {
    const store = new ConversationStore(makeJournalDbProvider(journalDbFile));
    const conversationId = store.ensureAutomationConversation(
      "brief/main",
      "brief",
      "Daily brief",
      "codex"
    );
    store.insertTurn({
      turnId: "prior",
      conversationId,
      triggerKind: "manual",
      triggerOrigin: "manual",
      startedAt: 10,
    });
    store.insertMessageIn({
      itemId: "prior-input",
      turnId: "prior",
      role: "user",
      text: '{"tick":1}',
      startedAt: 10,
    });
    store.finishTurn({
      turnId: "prior",
      endedAt: 20,
      ok: true,
      summary: "Found two important changes.",
      outputJson: '{"count":2}',
    });
    if (withHandle)
      store.noteTurn(conversationId, "", {
        kind: "codex",
        sessionId: "cached-1",
      });
    store.close();
  }

  async function runHarness(input: {
    withHandle: boolean;
    emit?: (turn: ConversationTurnInput) => void;
    prepareArtifacts?: (
      dir: string
    ) => Promise<
      Pick<
        Parameters<typeof runInteractiveAutomationTurn>[0],
        "artifactRoots" | "uploadInlineArtifact"
      >
    >;
  }): Promise<{
    received: ConversationTurnInput;
    stream: TurnStreamEvent[];
    bus: AutomationTurnStreamEvent[];
    store: ConversationStore;
  }> {
    const dir = await tempDir("interactive-automation-turn-");
    dirs.push(dir);
    const journalDbFile = path.join(dir, "journal.db");
    seed(journalDbFile, input.withHandle);
    const artifactOptions = (await input.prepareArtifacts?.(dir)) ?? {};
    let received!: ConversationTurnInput;
    const runner: ConversationRunner = {
      run: async (turn) => {
        received = turn;
        input.emit?.(turn);
        return { harnessKind: "codex", harnessSessionId: "cached-2" };
      },
    };
    const stream: TurnStreamEvent[] = [];
    const bus: AutomationTurnStreamEvent[] = [];
    await runInteractiveAutomationTurn({
      row: row(dir),
      turnId: "interactive-1",
      message: "What changed?",
      journalDbFile,
      harnessSessionDir: path.join(dir, "sessions"),
      runner,
      harnessKind: "codex",
      model: "gpt-test",
      abortSignal: new AbortController().signal,
      conversationLocks: new Map(),
      onEvent: (event) => stream.push(event),
      onTurnEvent: (event) => bus.push(event),
      ...artifactOptions,
    });
    return {
      received,
      stream,
      bus,
      store: new ConversationStore(makeJournalDbProvider(journalDbFile)),
    };
  }

  describe(runInteractiveAutomationTurn, () => {
    it("is ledger-equivalent cold and resumed while using the cached handle only as an optimization", async () => {
      const cold = await runHarness({ withHandle: false });
      const resumed = await runHarness({ withHandle: true });
      expect(cold.received.extraSystemPrompt).toBe(
        resumed.received.extraSystemPrompt
      );
      expect(cold.received.prevHarnessSessionId).toBeUndefined();
      expect(resumed.received.prevHarnessSessionId).toBe("cached-1");
      expect(resumed.received.permissionPolicy).toBe("deny");
      expect(resumed.received.harnessKind).toBe("codex");
      expect(resumed.received.model).toBe("gpt-test");
      expect(resumed.store.getConversation("brief/main")).toMatchObject({
        harnessKind: "codex",
        harnessSessionId: "cached-2",
      });
      cold.store.close();
      resumed.store.close();
    });

    it("persists a native interactive trace and fans the same events to second viewers", async () => {
      const out = await runHarness({
        withHandle: false,
        emit: (turn) => {
          turn.onEvent({ type: "assistant.delta", delta: "Two changes." });
          turn.onEvent({
            type: "tool.start",
            toolCallId: "call-1",
            toolName: "vault_read",
            args: { entity: "core.message" },
            rawJson: '{"sessionUpdate":"tool_call"}',
          });
          turn.onEvent({
            type: "tool.result",
            toolCallId: "call-1",
            toolName: "vault_read",
            ok: true,
            result: { rows: 2 },
            rawJson: '{"sessionUpdate":"tool_call_update"}',
          });
          turn.onEvent({
            type: "usage",
            model: "gpt-test",
            inputTokens: 100,
            outputTokens: 20,
            costUsd: 0.01,
          });
          turn.onEvent({
            type: "final",
            text: "Two changes.",
            stopReason: "end_turn",
            rawJson: '{"stopReason":"end_turn"}',
          });
        },
      });
      expect(out.stream.at(-1)).toMatchObject({
        type: "final",
        stopReason: "end_turn",
      });
      expect(out.bus[0]).toStrictEqual({
        type: "turn.start",
        turnId: "interactive-1",
      });
      expect(out.bus.at(-1)).toStrictEqual({
        type: "turn.end",
        turnId: "interactive-1",
        ok: true,
      });
      expect(out.store.getTurn("interactive-1")).toMatchObject({
        triggerKind: "interactive",
        ok: true,
        totalInputTokens: 100,
        totalOutputTokens: 20,
        totalCostUsd: 0.01,
      });
      expect(out.store.listItems("interactive-1")).toStrictEqual([
        expect.objectContaining({ kind: "message_in", text: "What changed?" }),
        expect.objectContaining({
          kind: "delegate",
          rawJson: '{"stopReason":"end_turn"}',
          inputTokens: 100,
          costSource: "harness",
        }),
        expect.objectContaining({
          kind: "tool",
          callId: "call-1",
          rawJson: '{"sessionUpdate":"tool_call_update"}',
        }),
      ]);
      out.store.close();
    });

    it("persists trusted tool locations and inline artifacts while rejecting escaped paths", async () => {
      let trustedPath = "";
      let escapedPath = "";
      const uploadInlineArtifact = vi.fn<
        NonNullable<
          Parameters<
            typeof runInteractiveAutomationTurn
          >[0]["uploadInlineArtifact"]
        >
      >(async (bytes) => ({
        hash: `inline-${Buffer.from(bytes).toString("hex")}`,
        sizeBytes: bytes.byteLength,
      }));
      const out = await runHarness({
        withHandle: false,
        prepareArtifacts: async (dir) => {
          const trustedRoot = path.join(dir, "workspace");
          trustedPath = path.join(trustedRoot, "report.txt");
          escapedPath = path.join(dir, "outside.txt");
          await fs.mkdir(trustedRoot, { recursive: true });
          await Promise.all([
            fs.writeFile(trustedPath, "trusted report"),
            fs.writeFile(escapedPath, "must not attach"),
          ]);
          return { artifactRoots: [trustedRoot], uploadInlineArtifact };
        },
        emit: (turn) => {
          turn.onEvent({
            type: "tool.start",
            toolCallId: "artifact-call",
            toolName: "write_report",
          });
          turn.onEvent({
            type: "tool.result",
            toolCallId: "artifact-call",
            toolName: "write_report",
            ok: true,
            result: { written: true },
            locations: [{ path: trustedPath }, { path: escapedPath }],
            artifacts: [
              {
                dataBase64: Buffer.from("inline artifact").toString("base64"),
                mime: "text/plain",
                filename: "inline.txt",
              },
            ],
          });
          turn.onEvent({ type: "final", text: "Artifacts ready." });
        },
      });
      const tool = out.store
        .listItems("interactive-1")
        .find(
          (item) => item.kind === "tool" && item.callId === "artifact-call"
        );
      expect(tool).toBeDefined();
      const attachments = out.store.listAttachmentsForItem(tool!.itemId);
      const [canonicalTrustedPath, canonicalEscapedPath] = await Promise.all([
        fs.realpath(trustedPath),
        fs.realpath(escapedPath),
      ]);
      expect(attachments).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({
            filename: "report.txt",
            mime: "application/octet-stream",
            source: "harness",
            workspacePath: canonicalTrustedPath,
          }),
          expect.objectContaining({
            filename: "inline.txt",
            hash: `inline-${Buffer.from("inline artifact").toString("hex")}`,
            mime: "text/plain",
            source: "harness",
          }),
        ])
      );
      expect(attachments).toHaveLength(2);
      expect(
        attachments.some(
          (attachment) => attachment.workspacePath === canonicalEscapedPath
        )
      ).toBe(false);
      expect(uploadInlineArtifact).toHaveBeenCalledOnce();
      out.store.close();
    });

    it("keeps one automation conversation and routes A→B→A through per-harness watermarks", async () => {
      const dir = await tempDir("interactive-automation-switch-");
      dirs.push(dir);
      const journalDbFile = path.join(dir, "journal.db");
      seed(journalDbFile, true);
      const calls: ConversationTurnInput[] = [];
      const runner: ConversationRunner = {
        run: async (turn) => {
          calls.push(turn);
          const isB = turn.harnessKind === "claude-code";
          turn.onEvent({
            type: "final",
            text: isB ? "B durable answer" : "A return answer",
          });
          return {
            harnessKind: isB ? "claude-code" : "codex",
            harnessSessionId: isB ? "session-b" : "cached-1",
            hydrated: true,
            hydrationTokens: turn.hydrationContext?.estimatedTokens,
          };
        },
      };
      const common = {
        row: row(dir),
        journalDbFile,
        harnessSessionDir: path.join(dir, "sessions"),
        runner,
        abortSignal: new AbortController().signal,
        conversationLocks: new Map<string, Promise<void>>(),
        onEvent: () => undefined,
      };

      await runInteractiveAutomationTurn({
        ...common,
        turnId: "interactive-b",
        message: "Ask B",
        harnessKind: "claude-code",
      });
      await runInteractiveAutomationTurn({
        ...common,
        turnId: "interactive-a-return",
        message: "Return to A",
        harnessKind: "codex",
      });

      expect(calls[0]?.prevHarnessSessionId).toBeUndefined();
      expect(calls[0]?.hydrationContext?.prompt).toContain(
        "Found two important changes."
      );
      expect(calls[1]?.prevHarnessSessionId).toBe("cached-1");
      expect(calls[1]?.hydrationContext?.prompt).toContain("B durable answer");
      expect(calls[1]?.hydrationContext?.prompt).not.toContain(
        "Found two important changes."
      );
      const store = new ConversationStore(makeJournalDbProvider(journalDbFile));
      expect(
        store.listTurns("brief/main").map((turn) => turn.turnId)
      ).toStrictEqual(["prior", "interactive-b", "interactive-a-return"]);
      expect(
        store.getHarnessBinding("brief/main", "claude-code")?.acpSessionId
      ).toBe("session-b");
      expect(store.getHarnessBinding("brief/main", "codex")?.acpSessionId).toBe(
        "cached-1"
      );
      expect(store.getTurn("interactive-b")?.hydrationTokens).toBeGreaterThan(
        0
      );
      store.close();
    });

    it("rolls back turn completion when the binding and watermark cannot commit", async () => {
      const dir = await tempDir("interactive-automation-atomic-");
      dirs.push(dir);
      const journalDbFile = path.join(dir, "journal.db");
      seed(journalDbFile, false);
      const noteTurn = vi
        .spyOn(ConversationStore.prototype, "noteTurn")
        .mockImplementationOnce(() => {
          throw new Error("binding write failed");
        });
      const runner: ConversationRunner = {
        run: async (turn) => {
          turn.onEvent({ type: "final", text: "Must not commit separately." });
          return {
            harnessKind: "codex",
            harnessSessionId: "atomic-session",
            hydrated: true,
            hydrationTokens: 12,
          };
        },
      };

      await expect(
        runInteractiveAutomationTurn({
          row: row(dir),
          turnId: "interactive-atomic",
          message: "Commit atomically",
          journalDbFile,
          harnessSessionDir: path.join(dir, "sessions"),
          runner,
          harnessKind: "codex",
          abortSignal: new AbortController().signal,
          conversationLocks: new Map(),
          onEvent: () => undefined,
        })
      ).rejects.toThrow("binding write failed");
      noteTurn.mockRestore();

      const store = new ConversationStore(makeJournalDbProvider(journalDbFile));
      const turn = store.getTurn("interactive-atomic");
      expect(turn?.endedAt).toBeUndefined();
      expect(turn?.hydrationTokens).toBeUndefined();
      expect(store.getHarnessBinding("brief/main", "codex")).toBeUndefined();
      const items = store.listItems("interactive-atomic");
      expect(items).toHaveLength(2);
      expect(items[0]).toMatchObject({ kind: "message_in" });
      expect(items[1]).toMatchObject({ kind: "delegate" });
      expect(items[1]?.endedAt).toBeUndefined();
      store.close();
    });
  });

  describe("consent.required", () => {
    it("keeps the user message durable and settles the turn instead of deleting it", async () => {
      const { stream, bus, store } = await runHarness({
        withHandle: false,
        emit: (turn) =>
          turn.onEvent({
            type: "consent.required",
            consentKind: "provider-egress",
            provider: "codex",
            reason: "direct",
            message: "Approve sending this conversation to codex.",
          }),
      });

      const turn = store.getTurn("interactive-1");
      // Deleting the turn would make the user retype after granting consent.
      expect(turn).toBeTruthy();
      expect(turn?.ok).toBe(false);
      expect(turn?.error).toBe("consent_required");
      expect(turn?.endedAt).toBeTypeOf("number");
      const items = store.listItems("interactive-1");
      expect(items.some((item) => item.kind === "message_in")).toBe(true);
      expect(bus.at(-1)).toMatchObject({
        type: "turn.end",
        ok: false,
        error: "consent_required",
      });
      expect(stream.some((event) => event.type === "consent.required")).toBe(
        true
      );
      store.close();
    });
  });
});
