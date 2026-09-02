import crypto from "node:crypto";
/** A fake `runTurn` stands in for the real harness spawn: it records what it was handed and simulates the agent authoring an automation with a pending webhook trigger (#141). */
import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { TurnInput, TurnConfig, TurnResult } from "@centraid/server/acp";
import type {
  Dispatcher,
  ConversationTurnInput,
  ProviderEgressConsentController,
  TurnStreamEvent,
} from "@centraid/server/engine";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { WorktreeStore } from "../worktree-store/index.js";
import { makeUnifiedConversationRunner } from "./unified-conversation-runner.ts";

let root: string;
let store: WorktreeStore;

const dispatcher = { describe: 0 } as unknown as Dispatcher;
const allowProviderEgress: ProviderEgressConsentController = {
  has: () => true,
  grant: () => undefined,
  revoke: () => undefined,
};

function baseInput(
  over: Partial<ConversationTurnInput>,
  onEvent: (e: TurnStreamEvent) => void
): ConversationTurnInput {
  return {
    appId: "notes",
    dataDir: path.join(root, "data", "notes"),
    conversationId: "win-1",
    sessionFile: path.join(root, "sessions", "win-1.jsonl"),
    message: "add a webhook automation",
    extraSystemPrompt: "BASE_DATA_PREAMBLE",
    abortSignal: new AbortController().signal,
    onEvent,
    ...over,
  };
}

describe("unified-conversation-runner", () => {
  beforeEach(async () => {
    root = await tempDir(`gw-unified-${crypto.randomUUID()}-`);
    store = new WorktreeStore({ root: path.join(root, "code") });
    await store.init();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("runs the turn in the draft worktree with the union of tools + the route preamble", async () => {
    let captured: { input: TurnInput; config: TurnConfig } | undefined;
    const events: TurnStreamEvent[] = [];

    const runner = makeUnifiedConversationRunner({
      store,
      prefsLoader: async () => ({ kind: "codex" }),
      getDispatcher: () => dispatcher,
      providerEgressConsent: allowProviderEgress,
      publicBaseUrl: () => "http://127.0.0.1:9999",
      runTurn: async (input, config): Promise<TurnResult> => {
        captured = { input, config };
        input.onEvent({ type: "assistant.delta", delta: "ok" });
        input.onEvent({ type: "final", text: "done" });
        return { harnessKind: "codex", sessionId: "thread-1" };
      },
    });

    const result = await runner.run(baseInput({}, (e) => events.push(e)));

    // cwd is the app's draft worktree app dir under the host-neutral `chat-<appId>` default session.
    const expectedCwd = await store.snapshotSessionAppDir(
      "chat-notes",
      "notes"
    );
    expect(captured?.input.cwd).toBe(expectedCwd);

    expect(captured?.input.toolContext?.appId).toBe("notes");
    expect(captured?.input.toolContext?.dispatcher).toBe(dispatcher);

    // The route's data preamble is kept verbatim; an `app` kind adds no authoring contract (#799) — only an automation does.
    expect(captured!.input.extraSystemPrompt).toBe("BASE_DATA_PREAMBLE");

    // The route reads `runKind` to persist its turns as `kind: 'build'` in the ledger (#181).
    expect(runner.runKind).toBe("build");

    expect(result?.harnessKind).toBe("codex");
    expect(result?.harnessSessionId).toBe("thread-1");
    expect(events.some((e) => e.type === "final")).toBeTruthy();
  });

  test("uses a one-shot draft session when the turn supplies one", async () => {
    let cwd = "";
    const runner = makeUnifiedConversationRunner({
      store,
      prefsLoader: async () => ({ kind: "codex" }),
      getDispatcher: () => dispatcher,
      providerEgressConsent: allowProviderEgress,
      publicBaseUrl: () => "http://127.0.0.1:9999",
      runTurn: async (input): Promise<TurnResult> => {
        cwd = input.cwd;
        return { harnessKind: "codex" };
      },
    });

    await runner.run(
      baseInput({ draftSessionId: "compile-notes-a1b2c3d4" }, () => undefined)
    );

    expect(cwd).toBe(
      await store.snapshotSessionAppDir("compile-notes-a1b2c3d4", "notes")
    );
    await expect(
      store.snapshotSessionAppDir("chat-notes", "notes")
    ).rejects.toMatchObject({
      code: "session_missing",
    });
  });

  test("mints a pending webhook authored during the turn and surfaces it once", async () => {
    const events: TurnStreamEvent[] = [];

    const runner = makeUnifiedConversationRunner({
      store,
      prefsLoader: async () => ({ kind: "codex" }),
      getDispatcher: () => dispatcher,
      providerEgressConsent: allowProviderEgress,
      publicBaseUrl: () => "http://127.0.0.1:9999",
      runTurn: async (input): Promise<TurnResult> => {
        // The agent authors an automation with a PENDING webhook trigger — it can't mint crypto-random credentials itself.
        const autoDir = path.join(input.cwd, "automations", "notify");
        await fs.mkdir(autoDir, { recursive: true });
        await fs.writeFile(
          path.join(autoDir, "automation.json"),
          JSON.stringify(
            {
              name: "Notify",
              version: "0.1.0",
              enabled: true,
              prompt: "fire on webhook",
              triggers: [{ kind: "webhook", pending: true }],
              requires: {},
              history: { keep: { count: 50 } },
              generated: { by: "test", at: "2026-05-22" },
            },
            null,
            2
          ),
          "utf8"
        );
        await fs.writeFile(
          path.join(autoDir, "handler.js"),
          "export default async () => ({});",
          "utf8"
        );
        return { harnessKind: "codex", sessionId: "thread-2" };
      },
    });

    await runner.run(baseInput({ appId: "notes" }, (e) => events.push(e)));

    const webhookEvents = events.filter((e) => e.type === "webhooks");
    expect(webhookEvents).toHaveLength(1);
    const evt = webhookEvents[0] as Extract<
      TurnStreamEvent,
      { type: "webhooks" }
    >;
    expect(evt.minted).toHaveLength(1);
    const minted = evt.minted[0]!;
    expect(minted.automationId).toBe("notify");
    expect(minted.ownerApp).toBe("notes");
    expect(minted.secret.length > 0).toBeTruthy();
    expect(minted.url).toMatch(
      /^http:\/\/127\.0\.0\.1:9999\/_centraid-hook\//u
    );

    // The staged manifest carries only a hash of the secret, not the plaintext.
    const appDir = await store.snapshotSessionAppDir("chat-notes", "notes");
    const raw = await fs.readFile(
      path.join(appDir, "automations", "notify", "automation.json"),
      "utf8"
    );
    const parsed = JSON.parse(raw) as {
      triggers: Array<{ kind: string; secretHash?: string; pending?: boolean }>;
    };
    const trig = parsed.triggers[0]!;
    expect(trig.kind).toBe("webhook");
    expect(trig.secretHash).toBeTruthy();
    expect(!trig.pending).toBeTruthy();
  });

  test("errors when no harness is configured", async () => {
    const events: TurnStreamEvent[] = [];
    const runner = makeUnifiedConversationRunner({
      store,
      prefsLoader: async () => undefined,
      getDispatcher: () => dispatcher,
      providerEgressConsent: allowProviderEgress,
      publicBaseUrl: () => "http://127.0.0.1:9999",
      runTurn: async (): Promise<TurnResult> => {
        throw new Error("should not be called");
      },
    });

    await expect(
      (() => runner.run(baseInput({}, (e) => events.push(e))))()
    ).rejects.toThrow("no harness configured");
    expect(events.some((e) => e.type === "error")).toBeTruthy();
  });
});
