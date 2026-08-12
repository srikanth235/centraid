/* Durable provider-egress consent at the automation TurnPlane door (#567, #743). */

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  ConversationStore,
  makeJournalDbProvider,
  ProviderEgressConsentStore,
} from "@centraid/app-engine";
import type {
  ProviderEgressConsentController,
  RunTurnFn,
} from "@centraid/app-engine";
import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";

import type { HarnessKind } from "../types.ts";
import { startLiveDispatch } from "./run-automation-live-dispatch.ts";
import type { LiveDispatch } from "./run-automation-live-dispatch.ts";

const openDispatches: LiveDispatch[] = [];
const dispatchCtx = {
  runId: "run-1",
  automationId: "demo/nightly",
  abortSignal: new AbortController().signal,
};

describe("automation provider-egress consent", () => {
  afterEach(async () => {
    await forEachSequentially(openDispatches.splice(0), (dispatch) =>
      dispatch.close().catch(() => undefined)
    );
  });

  /** Exercise the durable controller over the fire's real journal. */
  async function openConsentedDispatch(opts: {
    harness: HarnessKind;
    ladderMembers: readonly HarnessKind[];
    consentSource?: "direct" | "ladder";
    seed?: (consent: ProviderEgressConsentStore) => void;
  }): Promise<{
    dispatch: LiveDispatch;
    consent: ProviderEgressConsentController;
    runTurn: ReturnType<typeof vi.fn<RunTurnFn>>;
  }> {
    const workdir = await tempDir("centraid-automation-consent-");
    const journalDbFile = `${workdir}/journal.db`;
    const store = new ConversationStore(makeJournalDbProvider(journalDbFile));
    store.ensureAutomationConversation(
      "demo/nightly",
      "demo",
      "Nightly",
      opts.harness
    );
    store.close();
    const consent = new ProviderEgressConsentStore(
      makeJournalDbProvider(journalDbFile),
      (kind) => opts.ladderMembers.includes(kind)
    );
    opts.seed?.(consent);
    const runTurn = vi.fn<RunTurnFn>(async (input, config) => {
      input.onEvent({ type: "final", text: "ok" });
      return { harnessKind: config.prefs.kind };
    });
    const dispatch = await startLiveDispatch({
      workdir,
      runId: "run-1",
      automationRef: "demo/nightly",
      journalDbFile,
      runTurn,
      harness: opts.harness,
      providerEgressConsent: consent,
      ...(opts.consentSource ? { consentSource: opts.consentSource } : {}),
      onLog: () => undefined,
    });
    openDispatches.push(dispatch);
    return { dispatch, consent, runTurn };
  }

  test("an unattended fire on the prefs primary egresses without a prompt", async () => {
    const { dispatch, consent, runTurn } = await openConsentedDispatch({
      harness: "codex",
      ladderMembers: [],
      consentSource: "direct",
    });

    await expect(
      dispatch.delegateDispatcher({ prompt: "go" }, dispatchCtx)
    ).resolves.toBe("ok");
    expect(runTurn).toHaveBeenCalledOnce();
    expect(consent.has("demo/nightly", "codex", "automations")).toBe(true);
  });

  test("an unattended fire on a current ladder member egresses without a prompt", async () => {
    const { dispatch, runTurn } = await openConsentedDispatch({
      harness: "claude-code",
      ladderMembers: ["claude-code"],
      consentSource: "ladder",
    });

    await expect(
      dispatch.delegateDispatcher({ prompt: "go" }, dispatchCtx)
    ).resolves.toBe("ok");
    expect(runTurn).toHaveBeenCalledOnce();
  });

  test("a revoked provider stays revoked across a later unattended fire", async () => {
    const { dispatch, runTurn } = await openConsentedDispatch({
      harness: "codex",
      ladderMembers: ["codex"],
      consentSource: "direct",
      seed: (consent) => {
        consent.grant("demo/nightly", "codex", "direct");
        consent.revoke("demo/nightly", "codex");
      },
    });

    await expect(
      dispatch.delegateDispatcher({ prompt: "go" }, dispatchCtx)
    ).rejects.toThrow(/not consented/u);
    expect(runTurn).not.toHaveBeenCalled();
  });

  test("an unauthored manifest-pinned harness is denied, not auto-granted", async () => {
    const { dispatch, consent, runTurn } = await openConsentedDispatch({
      harness: "gemini",
      ladderMembers: ["claude-code"],
      consentSource: "ladder",
    });

    await expect(
      dispatch.delegateDispatcher({ prompt: "go" }, dispatchCtx)
    ).rejects.toThrow(/gemini/u);
    expect(runTurn).not.toHaveBeenCalled();
    expect(consent.has("demo/nightly", "gemini", "automations")).toBe(false);
  });
});
