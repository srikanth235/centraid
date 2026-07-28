import { promises as fs } from "node:fs";
import path from "node:path";

import {
  ConversationStore,
  makeJournalDbProvider,
  type RunTurnFn,
} from "@centraid/app-engine";
import {
  validateManifest,
  type Row as AutomationRow,
} from "@centraid/automation";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanRewrittenInstructions,
  rewriteAutomationInstructions,
  rewriteWorkOrder,
} from "./rewrite-automation-instructions.js";

const dirs: string[] = [];
describe("rewrite-automation-instructions", () => {
  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

  function row(dir: string): AutomationRow {
    const manifest = validateManifest({
      name: "Brief",
      version: "0.1.0",
      enabled: true,
      prompt: "Summarize all mail.",
      triggers: [{ kind: "cron", expr: "0 9 * * *" }],
      requires: {},
      history: { keep: { count: 50 } },
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

  describe("rewrite instruction helpers", () => {
    it("keeps the current prompt and steering request explicit", () => {
      expect(rewriteWorkOrder("Old prompt", "Only urgent mail")).toContain(
        "Old prompt"
      );
      expect(rewriteWorkOrder("Old prompt", "Only urgent mail")).toContain(
        "Only urgent mail"
      );
    });

    it("strips wrappers without changing the rewritten content", () => {
      expect(
        cleanRewrittenInstructions("```markdown\nOnly urgent mail.\n```")
      ).toBe("Only urgent mail.");
      expect(
        cleanRewrittenInstructions("Revised instructions: Only urgent mail.")
      ).toBe("Only urgent mail.");
    });
  });

  describe(rewriteAutomationInstructions, () => {
    it("uses a tool-less denied-permission turn, persists, and records a thread card", async () => {
      const dir = await tempDir("automation-rewrite-");
      dirs.push(dir);
      const journalDbFile = path.join(dir, "journal.db");
      const persistPrompt = vi
        .fn<(prompt: string) => Promise<void>>()
        .mockResolvedValue(undefined);
      const runTurn: RunTurnFn = async (input, config) => {
        expect(input.toolContext).toBeUndefined();
        expect(input.permissionPolicy).toBe("deny");
        expect(input.model).toBe("fast-model");
        expect(config.prefs.kind).toBe("codex");
        input.onEvent({
          type: "assistant.delta",
          delta: "Summarize only urgent mail.",
        });
        input.onEvent({
          type: "usage",
          model: "fast-model",
          inputTokens: 20,
          outputTokens: 6,
          costUsd: 0.002,
        });
        input.onEvent({
          type: "final",
          text: "Summarize only urgent mail.",
          stopReason: "end_turn",
          rawJson: '{"stopReason":"end_turn"}',
        });
        return { adapterKind: "codex" };
      };
      const result = await rewriteAutomationInstructions({
        row: row(dir),
        steering: "Only urgent mail.",
        revisionTurnId: "revision-1",
        journalDbFile,
        runnerSessionDir: path.join(dir, "sessions"),
        runTurn,
        runnerPrefs: { kind: "codex" },
        model: "fast-model",
        persistPrompt,
      });
      expect(result.prompt).toBe("Summarize only urgent mail.");
      expect(persistPrompt).toHaveBeenCalledWith("Summarize only urgent mail.");

      const store = new ConversationStore(makeJournalDbProvider(journalDbFile));
      expect(store.getTurn("revision-1")).toMatchObject({
        triggerKind: "interactive",
        summary: "Revised instructions",
        ok: true,
        totalCostUsd: 0.002,
      });
      expect(store.listItems("revision-1")).toStrictEqual([
        expect.objectContaining({
          kind: "message_in",
          text: "Only urgent mail.",
        }),
        expect.objectContaining({
          kind: "step",
          outputJson: '{"text":"Revised instructions","stopReason":"end_turn"}',
          rawJson: '{"stopReason":"end_turn"}',
        }),
      ]);
      store.close();
    });

    it("records failure and does not persist an empty rewrite", async () => {
      const dir = await tempDir("automation-rewrite-fail-");
      dirs.push(dir);
      const journalDbFile = path.join(dir, "journal.db");
      const persistPrompt = vi.fn<(prompt: string) => Promise<void>>();
      await expect(
        rewriteAutomationInstructions({
          row: row(dir),
          steering: "Change it.",
          revisionTurnId: "revision-fail",
          journalDbFile,
          runnerSessionDir: path.join(dir, "sessions"),
          runTurn: async () => ({ adapterKind: "codex" }),
          runnerPrefs: { kind: "codex" },
          persistPrompt,
        })
      ).rejects.toThrow(/empty/iu);
      expect(persistPrompt).not.toHaveBeenCalled();
      const store = new ConversationStore(makeJournalDbProvider(journalDbFile));
      expect(store.getTurn("revision-fail")).toMatchObject({
        ok: false,
        summary: "Instruction revision failed",
      });
      store.close();
    });

    it("preserves a failed rewrite terminal, raw envelope, and usage for cold replay", async () => {
      const dir = await tempDir("automation-rewrite-terminal-fail-");
      dirs.push(dir);
      const journalDbFile = path.join(dir, "journal.db");
      const persistPrompt = vi.fn<(prompt: string) => Promise<void>>();
      await expect(
        rewriteAutomationInstructions({
          row: row(dir),
          steering: "Change it.",
          revisionTurnId: "revision-terminal-fail",
          journalDbFile,
          runnerSessionDir: path.join(dir, "sessions"),
          runTurn: async (input) => {
            input.onEvent({
              type: "error",
              message: "The rewriter refused.",
              stopReason: "refusal",
              rawJson: '{"stopReason":"refusal","detail":"policy"}',
            });
            input.onEvent({
              type: "usage",
              model: "fast-model",
              inputTokens: 8,
              outputTokens: 0,
              costUsd: 0.001,
            });
            return { adapterKind: "codex" };
          },
          runnerPrefs: { kind: "codex" },
          persistPrompt,
        })
      ).rejects.toThrow("The rewriter refused.");
      expect(persistPrompt).not.toHaveBeenCalled();
      const store = new ConversationStore(makeJournalDbProvider(journalDbFile));
      expect(store.getTurn("revision-terminal-fail")).toMatchObject({
        ok: false,
        outputJson: '{"stopReason":"refusal","error":"The rewriter refused."}',
      });
      expect(store.listItems("revision-terminal-fail")).toContainEqual(
        expect.objectContaining({
          kind: "step",
          ok: false,
          error: "The rewriter refused.",
          rawJson: '{"stopReason":"refusal","detail":"policy"}',
          outputJson:
            '{"error":"The rewriter refused.","stopReason":"refusal"}',
          model: "fast-model",
          costUsd: 0.001,
        })
      );
      store.close();
    });
  });
});
