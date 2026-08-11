/*
 * Live `ctx.agent` dispatch for the local automation harness.
 *
 * Split out of `run-automation.ts` so that file can stay focused on the
 * per-fire lifecycle (manifest load, audit store, onFailure cascade). This
 * module owns the one billed rail — `ctx.agent`, a bounded one-shot turn
 * against the user's real provider.
 *
 * Issue #479 — `ctx.agent` honours every registered harness kind through ONE
 * path: `getHarness(kind).runTurn`, the same seam chat uses. Pinning
 * `harness.automations` to any kind actually drives that agent.
 *
 * Issue #484 — the `ctx.tool` rail was removed. It used to dispatch tool
 * batches to a persistent mock-LLM session that puppeted the claude/codex
 * CLIs; that mock HTTP server started eagerly per fire even when unused. It
 * is gone. A fire whose handler never calls `ctx.agent` now starts ZERO child
 * processes and ZERO HTTP servers: the deterministic rails (`ctx.vault`,
 * `ctx.fetch`, `ctx.state`, `ctx.runs`) are serviced in-process, parent-side.
 * The only thing this surface allocates lazily is a scratch dir — and only
 * when a `ctx.agent` call actually carries vault-derivative attachments.
 *
 * Issue #91: an automation is a standalone app — the agent runs with the app
 * directory as cwd, and the dispatch context carries the automation id (no
 * owning app).
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  HarnessFailureClass,
  ProviderConsentSource,
  ProviderEgressConsentController,
  HarnessHealthController,
  HarnessKind,
  HarnessPrefs,
  TurnStreamEvent,
} from "@centraid/app-engine";
import {
  compileHydrationPlan,
  ConversationStore,
  hydrationMessagesFromLedger,
  makeJournalDbProvider,
} from "@centraid/app-engine";
import type * as TypeImport_4y0tle from "@centraid/app-engine";
import * as automation from "@centraid/automation";

import { getHarness } from "../registry.js";

export interface LiveDispatchOptions {
  /** The automation app directory — also the agent's cwd. */
  workdir: string;
  runId: string;
  /** Stable automation conversation identity (`<appId>/<automationId>`). */
  automationRef: string;
  /** Canonical per-vault ledger holding harness bindings and hydration watermarks. */
  journalDbFile: string;
  harness: HarnessKind;
  /**
   * Model id/alias for `ctx.agent` calls (manifest `requires.model`, or the
   * caller's prefs-resolved fallback — see `RunAutomationOptions.model`).
   * Undefined means "no override" — the backend's own default applies.
   */
  model?: string;
  /** Semantic ACP configuration pins, keyed by capability category. */
  configPins?: Readonly<Record<string, string>>;
  /** Load launch settings/default config for this fire's selected harness. */
  harnessPrefsFor?: (harness: HarnessKind) => Promise<HarnessPrefs | undefined>;
  harnessHealth?: HarnessHealthController;
  harnessHealthContext?: string;
  providerEgressConsent?: ProviderEgressConsentController;
  /**
   * How the user authored this rung's harness: `direct` = their automations
   * primary, `ladder` = current failover membership (validated against the
   * live ladder before anything egresses). Both are user-authored consent
   * (#567 D13). Omit when the harness came from a source the user did not
   * author — a manifest `requires.harness` pin naming a provider absent from
   * their settings — so the fire is denied unless a real grant already exists.
   */
  consentSource?: ProviderConsentSource;
  /** Resolve historical upload hashes into the owning automation's blob CAS. */
  hydrationAttachmentPath?: (hash: string) => string;
  onLog: (level: "info" | "warn" | "error", msg: string) => void;
}

export interface LiveDispatch {
  agentDispatcher: automation.AgentDispatcher;
  finalizeTurn: (
    store: ConversationStore,
    conversationId: string,
    turnId: string,
    ok: boolean
  ) => void;
  /** Tear down the scratch dir (only ever created if an attachment was
   *  staged). Safe to call once. */
  close: () => Promise<void>;
}

const AGENT_FAILURE_PREFIX = "centraid-agent-failure:";

export interface AutomationAgentFailure {
  harness: HarnessKind;
  failureClass: HarnessFailureClass;
  message: string;
}

/** Preserve typed harness failure metadata through the handler worker boundary. */
export function parseAutomationAgentFailure(
  error: string | undefined
): AutomationAgentFailure | undefined {
  if (!error) return undefined;
  const at = error.indexOf(AGENT_FAILURE_PREFIX);
  if (at < 0) return undefined;
  try {
    // Handler workers preserve the original error text but append their own
    // stack after a newline. The structured marker is deliberately one
    // JSON-encoded line (embedded newlines in `message` are escaped), so only
    // parse that line instead of letting a worker stack suppress failover.
    const payload = error
      .slice(at + AGENT_FAILURE_PREFIX.length)
      .split(/\r?\n/u, 1)[0]
      ?.trim();
    const parsed = JSON.parse(payload ?? "") as {
      harness?: unknown;
      failureClass?: unknown;
      message?: unknown;
    };
    if (
      typeof parsed.harness !== "string" ||
      typeof parsed.failureClass !== "string" ||
      typeof parsed.message !== "string"
    ) {
      return undefined;
    }
    return parsed as AutomationAgentFailure;
  } catch {
    return undefined;
  }
}

function agentFailureError(failure: AutomationAgentFailure): Error {
  return new Error(`${AGENT_FAILURE_PREFIX}${JSON.stringify(failure)}`);
}

/**
 * Stand up the live dispatch surface for the CLI harness. `ctx.agent` routes to
 * the user's REAL provider through the harness registry; everything else on the
 * `ctx.*` surface is deterministic and serviced parent-side, so this allocates
 * nothing eagerly. The scratch dir is created lazily, only when a `ctx.agent`
 * call carries vault derivatives to stage.
 */
export async function startLiveDispatch(
  opts: LiveDispatchOptions
): Promise<LiveDispatch> {
  const scratchDir = path.join(opts.workdir, ".automation-scratch", opts.runId);
  let scratchReady = false;
  const runsStore = new ConversationStore(
    makeJournalDbProvider(opts.journalDbFile)
  );
  const lockToken = randomUUID();
  if (!runsStore.acquireTurnLock(opts.automationRef, lockToken)) {
    runsStore.close();
    throw new Error(
      `automation conversation "${opts.automationRef}" already has a running turn`
    );
  }
  const lockLeaseHeartbeat = setInterval(
    () => runsStore.refreshTurnLock(opts.automationRef, lockToken),
    60_000
  );
  lockLeaseHeartbeat.unref?.();
  let latestHarness:
    | {
        kind: string;
        sessionId?: string;
        usageSnapshot?: TypeImport_4y0tle.AdapterUsageSnapshot;
        hydrated?: boolean;
      }
    | undefined;
  let observedHarness:
    | {
        kind: string;
        sessionId?: string;
        usageSnapshot?: TypeImport_4y0tle.AdapterUsageSnapshot;
        hydrated?: boolean;
      }
    | undefined;
  let hydrationTokens = 0;
  const ensureScratch = async (): Promise<void> => {
    if (scratchReady) return;
    await fs.mkdir(scratchDir, { recursive: true });
    scratchReady = true;
  };

  // Vault-derivative attachments (issue #299): the harness already resolved
  // and receipted them; here they become scratch files the agent's native
  // multimodal Read path picks up — one mechanism for every harness, no
  // per-backend wire format. The scratch dir materializes only on first use.
  const stageAttachments = async (
    call: automation.AgentCall
  ): Promise<{
    prompt: string;
    attachments?: Array<{ path: string; mime: string; filename?: string }>;
  }> => {
    if (!call.attachments?.length) return { prompt: call.prompt };
    await ensureScratch();
    const attachments = await Promise.all(
      call.attachments.map(async (att) => {
        const file = path.join(
          scratchDir,
          `attach-${randomUUID().slice(0, 8)}-${att.name}`
        );
        if (att.base64 === undefined) {
          await fs.writeFile(file, att.text ?? "", "utf8");
        } else {
          await fs.writeFile(file, Buffer.from(att.base64, "base64"));
        }
        return { path: file, mime: att.mediaType, filename: att.name };
      })
    );
    return { prompt: call.prompt, attachments };
  };

  // ctx.agent routes to the user's REAL provider through the SAME harness
  // registry chat uses — one integration path for every kind (issue #479).
  // `runTurn` normalizes each agent's stream into TurnStreamEvents, so this
  // reads `final` / `error` and coerces the answer with no per-backend wire
  // format anywhere in this file.
  //
  // Two deliberate limits. (1) ACP has no `--output-schema` equivalent, so
  // `call.json` is enforced by `coerceAgentAnswer` alone. (2) A fire carries
  // only the harness KIND (the gateway drops binPath / extraArgs for every
  // kind), so the backend resolves its default binary off PATH. The custom
  // `acp` kind has no default binary and therefore surfaces a clear `error`
  // event, raised below.
  const agentDispatcher: automation.AgentDispatcher = async (
    call,
    ctx
  ): Promise<unknown> => {
    const harness = opts.harness;
    // Unattended egress is never prompted (#567 D5) — it is authorized at
    // authoring time. So derive the grant honestly rather than minting one:
    // `recordDerived` refuses to resurrect a revoked provider and refuses a
    // ladder source the user's live settings do not contain. A controller
    // without the derived-consent seam denies rather than assumes.
    const consent = opts.providerEgressConsent;
    if (consent && !consent.has(opts.automationRef, harness, "automations")) {
      const derived =
        opts.consentSource === undefined
          ? false
          : (consent.recordDerived?.(
              opts.automationRef,
              harness,
              opts.consentSource,
              "automations"
            ) ?? false);
      if (!derived) {
        throw agentFailureError({
          harness,
          failureClass: "unknown",
          message:
            `Unattended egress to ${harness} is not consented for ${opts.automationRef}. ` +
            `Add ${harness} to the automations agent or its failover ladder in Settings, ` +
            `or run this automation interactively and approve the provider.`,
        });
      }
    }
    const staged = await stageAttachments(call);
    const scope = opts.harnessHealthContext ?? opts.workdir;
    const breaker = opts.harnessHealth?.canAttempt(scope, harness);
    if (breaker && !breaker.allowed) {
      throw agentFailureError({
        harness,
        failureClass: breaker.failureClass ?? "unknown",
        message: `Harness breaker is open${breaker.breakerUntil ? ` until ${new Date(breaker.breakerUntil).toISOString()}` : ""}.`,
      });
    }
    const loaded = (await opts.harnessPrefsFor?.(harness)) ?? { kind: harness };
    const prefs: HarnessPrefs =
      loaded.kind === harness ? loaded : { kind: harness };
    let finalText = "";
    let failure: Extract<TurnStreamEvent, { type: "error" }> | undefined;
    const binding =
      latestHarness?.sessionId === undefined
        ? runsStore.getHarnessBinding(opts.automationRef, harness)
        : undefined;
    const resumeSessionId = latestHarness?.sessionId ?? binding?.acpSessionId;
    const resumeUsage = latestHarness?.usageSnapshot ?? binding?.usageSnapshot;
    const completedTurns = runsStore.listTurns(opts.automationRef);
    const hydrationMessages =
      latestHarness === undefined
        ? hydrationMessagesFromLedger(
            completedTurns,
            (turnId) => runsStore.listItems(turnId),
            (itemId) => runsStore.listAttachmentsForItem(itemId),
            binding?.hydratedThroughSeq ?? -1
          )
        : [];
    const recoveryMessages =
      latestHarness === undefined && binding
        ? hydrationMessagesFromLedger(
            completedTurns,
            (turnId) => runsStore.listItems(turnId),
            (itemId) => runsStore.listAttachmentsForItem(itemId)
          )
        : [];
    const hydrationPlan =
      hydrationMessages.length > 0
        ? compileHydrationPlan(hydrationMessages, {
            includeAttachmentReferences: true,
          })
        : undefined;
    const recoveryHydrationPlan =
      recoveryMessages.length > 0
        ? compileHydrationPlan(recoveryMessages, {
            includeAttachmentReferences: true,
          })
        : undefined;
    let result:
      | {
          sessionId?: string;
          harnessKind: string;
          usageSnapshot?: TypeImport_4y0tle.AdapterUsageSnapshot;
          hydrated?: boolean;
          hydrationKind?: "handoff" | "recovery";
        }
      | undefined;
    try {
      result = await getHarness(harness).runTurn(
        {
          conversationId: opts.automationRef,
          cwd: opts.workdir,
          message: staged.prompt,
          ...(staged.attachments ? { attachments: staged.attachments } : {}),
          extraSystemPrompt: "",
          ...(opts.model ? { model: opts.model } : {}),
          ...((opts.configPins ?? prefs.configPins)
            ? { configPins: opts.configPins ?? prefs.configPins }
            : {}),
          abortSignal: ctx.abortSignal,
          ...(resumeSessionId ? { prevSessionId: resumeSessionId } : {}),
          ...(resumeUsage ? { prevUsageSnapshot: resumeUsage } : {}),
          ...(hydrationPlan
            ? {
                hydrationContext: hydrationPlan.prompt,
                forceHydration: true,
              }
            : {}),
          ...(opts.hydrationAttachmentPath && hydrationPlan?.attachments.length
            ? {
                hydrationAttachments: hydrationPlan.attachments.map(
                  (attachment) => ({
                    path: opts.hydrationAttachmentPath!(attachment.hash),
                    mime: attachment.mime,
                    ...(attachment.filename
                      ? { filename: attachment.filename }
                      : {}),
                  })
                ),
              }
            : {}),
          ...(recoveryHydrationPlan
            ? { recoveryHydrationContext: recoveryHydrationPlan.prompt }
            : {}),
          ...(opts.hydrationAttachmentPath &&
          recoveryHydrationPlan?.attachments.length
            ? {
                recoveryHydrationAttachments:
                  recoveryHydrationPlan.attachments.map((attachment) => ({
                    path: opts.hydrationAttachmentPath!(attachment.hash),
                    mime: attachment.mime,
                    ...(attachment.filename
                      ? { filename: attachment.filename }
                      : {}),
                  })),
              }
            : {}),
          onEvent: (event) => {
            if (event.type === "final") finalText = event.text;
            if (event.type === "error") failure = event;
            call.onEvent?.(event);
          },
        },
        { prefs }
      );
    } catch (error) {
      failure = {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        failureClass: "unknown",
      };
    }
    if (result) {
      observedHarness = {
        kind: result.harnessKind,
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        ...(result.usageSnapshot
          ? { usageSnapshot: result.usageSnapshot }
          : {}),
        ...(result.hydrated ? { hydrated: true } : {}),
      };
      if (result.hydrated) {
        hydrationTokens +=
          result.hydrationKind === "recovery"
            ? (recoveryHydrationPlan?.estimatedTokens ?? 0)
            : (hydrationPlan?.estimatedTokens ?? 0);
      }
    }
    if (!failure) {
      if (result) {
        latestHarness = observedHarness;
      }
      opts.harnessHealth?.reportOk(scope, harness);
      return automation.coerceAgentAnswer(finalText, call.json);
    }
    const typedFailure: AutomationAgentFailure = {
      harness,
      failureClass: failure.failureClass ?? "unknown",
      message: failure.message,
    };
    opts.harnessHealth?.reportFailure(
      scope,
      harness,
      typedFailure.failureClass,
      typedFailure.message
    );
    throw agentFailureError(typedFailure);
  };

  let closed = false;
  return {
    agentDispatcher,
    finalizeTurn(store, conversationId, turnId, ok): void {
      if (hydrationTokens > 0) {
        store.setTurnHydrationTokens(turnId, hydrationTokens);
      }
      if (ok) store.noteTurn(conversationId, "", latestHarness);
      else store.noteFailedTurn(conversationId, "", observedHarness);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        // Turn settlement owns binding/watermark finalization transactionally
        // through `finalizeTurn`; close only releases process-local resources.
      } finally {
        clearInterval(lockLeaseHeartbeat);
        runsStore.releaseTurnLock(opts.automationRef, lockToken);
        runsStore.close();
      }
      // Only ever created if an attachment was staged — the rm is a no-op
      // otherwise, so a tool-free / attachment-free fire touches no disk here.
      if (scratchReady) {
        await fs
          .rm(scratchDir, { recursive: true, force: true })
          .catch(() => undefined);
      }
    },
  };
}
