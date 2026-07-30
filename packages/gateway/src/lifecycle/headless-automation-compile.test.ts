import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConversationStore,
  ProviderEgressConsentStore,
  makeJournalDbProvider,
} from "@centraid/app-engine";
import type { ConversationRunner } from "@centraid/app-engine";
import { validateManifest } from "@centraid/automation";
import { tempDir } from "@centraid/test-kit/temp-dir";

import type { ResolvedAutomationAnchor } from "./automation-anchor-scopes.js";
import {
  HEADLESS_COMPILE_WORK_ORDER,
  finalizeCompiledManifest,
  recordFailedAutomationCompile,
  runHeadlessAutomationCompile,
} from "./headless-automation-compile.js";

type CompileOptions = Parameters<typeof runHeadlessAutomationCompile>[0];
type CompileSuccess = CompileOptions["onSuccess"];
type CompileFailure = NonNullable<CompileOptions["onFailure"]>;

const ANCHOR: ResolvedAutomationAnchor = {
  token: "@[core.link_anchor/anchor-1]",
  anchorId: "anchor-1",
  linkId: "link-1",
  sourceType: "schedule.task",
  sourceId: "task-1",
  sourceField: "title",
  targetType: "core.party",
  targetId: "party-1",
  selector: { exact: "quarterly report", prefix: "", suffix: "", start: 8 },
  scope: {
    schema: "schedule",
    table: "task",
    verbs: "read",
    rowFilter: [{ column: "task_id", op: "eq", value: "task-1" }],
    fieldMask: ["task_id", "title"],
  },
};

const dirs: string[] = [];
describe("headless-automation-compile suite", () => {
  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

  async function harness(
    runner: ConversationRunner,
    agent: {
      runnerKind?: "claude-code";
      model?: string;
      preflightError?: string;
    } = {}
  ) {
    const dir = await tempDir("centraid-headless-compile-");
    dirs.push(dir);
    const journalDbFile = path.join(dir, "journal.db");
    const onSuccess = vi.fn<CompileSuccess>().mockResolvedValue(undefined);
    const onFailure = vi.fn<CompileFailure>().mockResolvedValue(undefined);
    await runHeadlessAutomationCompile({
      runner,
      journalDbFile,
      runnerSessionDir: path.join(dir, "sessions"),
      dataDir: path.join(dir, "apps"),
      appId: "digest",
      draftSessionId: "compile-digest-1",
      automationRef: "digest/main",
      automationName: "Daily digest",
      instructions: "Summarize mail about @[core.party/p-1].",
      ...agent,
      onSuccess,
      onFailure,
      runId: "compile-1",
    });
    return {
      store: new ConversationStore(makeJournalDbProvider(journalDbFile)),
      onSuccess,
      onFailure,
    };
  }

  describe(runHeadlessAutomationCompile, () => {
    it("records a successful compile turn on the stable automation conversation", async () => {
      let receivedDraftSessionId: string | undefined;
      let receivedRunnerKind: string | undefined;
      let receivedModel: string | undefined;
      const runner: ConversationRunner = {
        run: async (input) => {
          receivedDraftSessionId = input.draftSessionId;
          receivedRunnerKind = input.runnerKind;
          receivedModel = input.model;
          input.onEvent({
            type: "final",
            text: "Files ready.",
            stopReason: "end_turn",
            rawJson: '{"stopReason":"end_turn"}',
          });
          input.onEvent({
            type: "usage",
            model: "test-model",
            inputTokens: 12,
            outputTokens: 4,
            costUsd: 0.004,
            costSource: "agent",
          });
          return { adapterKind: "codex" };
        },
      };
      const { store, onSuccess, onFailure } = await harness(runner, {
        runnerKind: "claude-code",
        model: "claude-custom",
      });
      expect(onSuccess).toHaveBeenCalledOnce();
      expect(onFailure).not.toHaveBeenCalled();
      expect(receivedDraftSessionId).toBe("compile-digest-1");
      expect(receivedRunnerKind).toBe("claude-code");
      expect(receivedModel).toBe("claude-custom");
      const conversationId = "digest/main";
      expect(store.getConversation(conversationId)?.title).toBe("Daily digest");
      const turn = store.getTurn("compile-1");
      expect(turn?.conversationId).toBe(conversationId);
      expect(turn?.triggerKind).toBe("compile");
      expect(turn?.ok).toBe(true);
      expect(turn?.summary).toBe("Plan ready");
      expect(store.messageInText("compile-1")).toContain(
        "ctx.vault.resolve({ refs: [{ type: 'core.party'"
      );
      expect(store.listItems("compile-1")).toStrictEqual([
        expect.objectContaining({ kind: "message_in" }),
        expect.objectContaining({
          kind: "step",
          model: "test-model",
          costUsd: 0.004,
          costSource: "agent",
          rawJson: '{"stopReason":"end_turn"}',
          outputJson: '{"text":"Files ready.","stopReason":"end_turn"}',
        }),
      ]);
      store.close();
    });

    it("records failure and does not publish when the runner rejects", async () => {
      const runner: ConversationRunner = {
        run: async () => {
          throw new Error("compiler unavailable");
        },
      };
      const { store, onSuccess, onFailure } = await harness(runner);
      expect(onSuccess).not.toHaveBeenCalled();
      expect(onFailure).toHaveBeenCalledWith("compiler unavailable");
      expect(store.getTurn("compile-1")).toMatchObject({
        ok: false,
        error: "compiler unavailable",
        summary: "Compile failed",
      });
      store.close();
    });

    it("preserves a failed runner terminal, raw envelope, and usage for cold replay", async () => {
      const runner: ConversationRunner = {
        run: async (input) => {
          input.onEvent({
            type: "error",
            message: "The compiler refused.",
            stopReason: "refusal",
            rawJson: '{"stopReason":"refusal","detail":"policy"}',
          });
          input.onEvent({
            type: "usage",
            model: "test-model",
            inputTokens: 7,
            outputTokens: 0,
            costUsd: 0.001,
          });
          return { adapterKind: "codex" };
        },
      };
      const { store, onSuccess, onFailure } = await harness(runner);
      expect(onSuccess).not.toHaveBeenCalled();
      expect(onFailure).toHaveBeenCalledWith("The compiler refused.");
      expect(store.getTurn("compile-1")).toMatchObject({
        ok: false,
        outputJson: '{"stopReason":"refusal","error":"The compiler refused."}',
      });
      expect(store.listItems("compile-1")).toContainEqual(
        expect.objectContaining({
          kind: "step",
          ok: false,
          error: "The compiler refused.",
          rawJson: '{"stopReason":"refusal","detail":"policy"}',
          outputJson:
            '{"error":"The compiler refused.","stopReason":"refusal"}',
          model: "test-model",
          costUsd: 0.001,
        })
      );
      store.close();
    });

    it("records an anchor preflight failure without starting the runner", async () => {
      const runner: ConversationRunner = {
        run: vi.fn<ConversationRunner["run"]>(),
      };
      const { store, onSuccess, onFailure } = await harness(runner, {
        preflightError: "anchor anchor-1 is missing or no longer live",
      });
      expect(runner.run).not.toHaveBeenCalled();
      expect(onSuccess).not.toHaveBeenCalled();
      expect(onFailure).toHaveBeenCalledWith(
        "anchor anchor-1 is missing or no longer live"
      );
      expect(store.getTurn("compile-1")).toMatchObject({
        ok: false,
        error: "anchor anchor-1 is missing or no longer live",
      });
      store.close();
    });

    it("frames the model turn as a work order and expands stable entity tokens", () => {
      const prompt = HEADLESS_COMPILE_WORK_ORDER("Notify @[core.event/e-1].");
      expect(prompt).toContain("work order, not a conversation");
      expect(prompt).toContain(
        "@[core.event/e-1] => await ctx.vault.resolve({ refs: [{ type: 'core.event', id: 'e-1' }]"
      );
      expect(prompt).toContain("generated.by = 'centraid-compiler'");
    });

    it("grounds anchor tokens in the trusted row, field, and exact span", () => {
      const prompt = HEADLESS_COMPILE_WORK_ORDER(
        "Notify about @[core.link_anchor/anchor-1].",
        [ANCHOR]
      );
      expect(prompt).toContain("Trusted anchor resolutions");
      expect(prompt).toContain(
        '@[core.link_anchor/anchor-1] => schedule.task/task-1 field title, exact span "quarterly report"'
      );
      expect(prompt).toContain("never broaden their declared scopes");
      expect(prompt).not.toContain("core.link_anchor entity kind");
    });

    it("instructs the compiler to pick data/condition triggers over cron polling", () => {
      const prompt = HEADLESS_COMPILE_WORK_ORDER(
        "Reconcile invoices when a transaction posts."
      );
      expect(prompt).toContain(
        "reacting to vault-data changes, declare a data trigger"
      );
      expect(prompt).toContain(
        'data-state window ("due in N days"), declare a condition trigger'
      );
      expect(prompt).toContain(
        "vault read scopes covering every watched entity"
      );
      expect(prompt).toContain(
        "instead of approximating either with a cron poll"
      );
      expect(prompt).toContain(
        "Leave existing cron/webhook triggers alone unless the instructions changed them."
      );
    });
  });

  describe(recordFailedAutomationCompile, () => {
    it("settles a reserved compile turn when instruction revision fails first", async () => {
      const dir = await tempDir("centraid-failed-revision-compile-");
      dirs.push(dir);
      const journalDbFile = path.join(dir, "journal.db");
      recordFailedAutomationCompile({
        journalDbFile,
        automationRef: "digest/main",
        appId: "digest",
        automationName: "Daily digest",
        runId: "compile-reserved",
        error: "Instruction revision failed: empty result",
        runnerKind: "claude-code",
      });

      const store = new ConversationStore(makeJournalDbProvider(journalDbFile));
      expect(store.getTurn("compile-reserved")).toMatchObject({
        conversationId: "digest/main",
        triggerKind: "compile",
        ok: false,
        error: "Instruction revision failed: empty result",
        summary: "Compile failed",
      });
      store.close();
    });
  });

  describe(finalizeCompiledManifest, () => {
    const manifest = () =>
      validateManifest({
        name: "Digest",
        version: "0.1.0",
        enabled: false,
        prompt: "Summarize @[core.event/e-1].",
        triggers: [],
        requires: {},
        history: { keep: { count: 50 } },
        generated: { by: "old", at: "2026-01-01T00:00:00.000Z" },
      });

    it("preserves recompile enablement, enables first compile, and derives tagged scopes", () => {
      const preserved = finalizeCompiledManifest(manifest(), {
        enabledBeforeCompile: true,
        enableOnSuccess: false,
        compiledAt: new Date("2026-07-13T00:00:00.000Z"),
      });
      expect(preserved.enabled).toBe(true);
      expect(preserved.vault?.scopes).toContainEqual({
        schema: "core",
        table: "event",
        verbs: "read",
      });
      expect(preserved.generated).toStrictEqual({
        by: "centraid-compiler",
        at: "2026-07-13T00:00:00.000Z",
      });

      expect(
        finalizeCompiledManifest(manifest(), {
          enabledBeforeCompile: false,
          enableOnSuccess: true,
        }).enabled
      ).toBe(true);
    });

    it("derives row/field scope from an anchored token without granting the anchor table", () => {
      const anchored = validateManifest({
        ...manifest(),
        prompt: "Notify about @[core.link_anchor/anchor-1].",
      });
      const compiled = finalizeCompiledManifest(anchored, {
        enabledBeforeCompile: false,
        enableOnSuccess: false,
        anchoredScopes: [ANCHOR.scope],
      });
      expect(compiled.vault?.scopes).toStrictEqual([ANCHOR.scope]);
      expect(compiled.vault?.scopes).not.toContainEqual({
        schema: "core",
        table: "link_anchor",
        verbs: "read",
      });
    });

    it("replaces a model-authored broad read on the anchored table", () => {
      const anchored = validateManifest({
        ...manifest(),
        prompt: "Notify about @[core.link_anchor/anchor-1].",
        vault: {
          purpose: "dpv:ServiceProvision",
          scopes: [
            { schema: "schedule", table: "task", verbs: "read" },
            { schema: "schedule", table: "event", verbs: "read" },
          ],
        },
      });
      const compiled = finalizeCompiledManifest(anchored, {
        enabledBeforeCompile: false,
        enableOnSuccess: false,
        anchoredScopes: [ANCHOR.scope],
      });
      expect(compiled.vault?.scopes).toStrictEqual([
        ANCHOR.scope,
        { schema: "schedule", table: "event", verbs: "read" },
      ]);
    });

    it("denies an unattended compile whose runner the user never authored", async () => {
      const dir = await tempDir("centraid-headless-compile-consent-");
      dirs.push(dir);
      const journalDbFile = path.join(dir, "journal.db");
      const run = vi.fn<ConversationRunner["run"]>();
      // The live automations ladder does not contain claude-code, so a manifest
      // pin naming it is not consent for unattended egress (#567 D13).
      const consent = new ProviderEgressConsentStore(
        makeJournalDbProvider(journalDbFile),
        () => false
      );
      const onFailure = vi.fn<CompileFailure>().mockResolvedValue(undefined);
      await runHeadlessAutomationCompile({
        runner: { run },
        journalDbFile,
        runnerSessionDir: path.join(dir, "sessions"),
        dataDir: path.join(dir, "apps"),
        appId: "digest",
        draftSessionId: "compile-digest-consent",
        automationRef: "digest/main",
        automationName: "Daily digest",
        instructions: "Summarize mail.",
        runnerKind: "claude-code",
        providerEgressConsent: consent,
        consentSource: "ladder",
        onSuccess: vi.fn<CompileSuccess>().mockResolvedValue(undefined),
        onFailure,
        runId: "compile-consent",
      });

      expect(run).not.toHaveBeenCalled();
      expect(onFailure).toHaveBeenCalledWith(
        expect.stringContaining("claude-code")
      );
      const store = new ConversationStore(makeJournalDbProvider(journalDbFile));
      const turn = store.getTurn("compile-consent");
      expect(turn?.ok).toBe(false);
      expect(turn?.error).toContain("no consent is recorded");
      store.close();
    });

    it("lets a ladder-member runner compile unattended without a prompt", async () => {
      const dir = await tempDir("centraid-headless-compile-consented-");
      dirs.push(dir);
      const journalDbFile = path.join(dir, "journal.db");
      const run = vi.fn<ConversationRunner["run"]>(async (input) => {
        input.onEvent({ type: "final", text: "Files ready." });
        return { adapterKind: "claude-code" };
      });
      const consent = new ProviderEgressConsentStore(
        makeJournalDbProvider(journalDbFile),
        () => true
      );
      await runHeadlessAutomationCompile({
        runner: { run },
        journalDbFile,
        runnerSessionDir: path.join(dir, "sessions"),
        dataDir: path.join(dir, "apps"),
        appId: "digest",
        draftSessionId: "compile-digest-consented",
        automationRef: "digest/main",
        automationName: "Daily digest",
        instructions: "Summarize mail.",
        runnerKind: "claude-code",
        providerEgressConsent: consent,
        consentSource: "ladder",
        onSuccess: vi.fn<CompileSuccess>().mockResolvedValue(undefined),
        runId: "compile-consented",
      });

      expect(run).toHaveBeenCalledOnce();
      const store = new ConversationStore(makeJournalDbProvider(journalDbFile));
      expect(store.getTurn("compile-consented")?.ok).toBe(true);
      store.close();
      expect(consent.has("digest/main", "claude-code", "automations")).toBe(
        true
      );
    });
  });
});
