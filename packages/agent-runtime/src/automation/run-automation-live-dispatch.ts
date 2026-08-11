// governance: allow-repo-hygiene file-size-limit (#740) one billed-rail transaction owns per-call consent, breaker, binding, hydration, ACP dispatch, and settlement
/*
 * Live `ctx.agent` dispatch for the local automation runner.
 *
 * Split out of `run-automation.ts` so that file can stay focused on the
 * per-fire lifecycle (manifest load, audit store, onFailure cascade). This
 * module owns the one billed rail — `ctx.agent`, a bounded one-shot turn
 * against the user's real provider.
 *
 * Issue #479 — `ctx.agent` honours every registered runner kind through ONE
 * path: `getRunnerBackend(kind).runTurn`, the same seam chat uses. Pinning
 * `runner.automations` to any kind actually drives that agent.
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
  AgentFailureClass,
  ProviderConsentSource,
  ProviderEgressConsentController,
  RunnerHealthController,
  RunnerKind,
  RunnerPrefs,
  TurnStreamEvent,
} from "@centraid/app-engine";
import {
  compileHydrationPlan,
  ConversationStore,
  hydrationMessagesFromLedger,
  isRunnerKind,
  makeJournalDbProvider,
} from "@centraid/app-engine";
import type * as TypeImport_4y0tle from "@centraid/app-engine";
import * as automation from "@centraid/automation";

import { getRunnerBackend } from "../registry.js";

export interface LiveDispatchOptions {
  /** The automation app directory — also the agent's cwd. */
  workdir: string;
  runId: string;
  /** Stable automation conversation identity (`<appId>/<automationId>`). */
  automationRef: string;
  /** Canonical per-vault ledger holding runner bindings and hydration watermarks. */
  journalDbFile: string;
  runner: RunnerKind;
  /**
   * Model id/alias for `ctx.agent` calls (manifest `requires.model`, or the
   * caller's prefs-resolved fallback — see `RunAutomationOptions.model`).
   * Undefined means "no override" — the backend's own default applies.
   */
  model?: string;
  /** Semantic ACP configuration pins, keyed by capability category. */
  configPins?: Readonly<Record<string, string>>;
  /** Load launch settings/default config for this fire's selected runner. */
  runnerPrefsFor?: (runner: RunnerKind) => Promise<RunnerPrefs | undefined>;
  runnerHealth?: RunnerHealthController;
  runnerHealthContext?: string;
  providerEgressConsent?: ProviderEgressConsentController;
  /**
   * How the user authored this rung's runner: `direct` = their automations
   * primary, `ladder` = current failover membership (validated against the
   * live ladder before anything egresses). Both are user-authored consent
   * (#567 D13). Omit when the runner came from a source the user did not
   * author — a manifest `requires.runner` pin naming a provider absent from
   * their settings — so the fire is denied unless a real grant already exists.
   */
  consentSource?: ProviderConsentSource;
  /**
   * Resolve user-authored consent for an explicit per-call runner. Undefined
   * means the named harness is outside the automations primary/ladder.
   */
  consentSourceFor?: (runner: RunnerKind) => ProviderConsentSource | undefined;
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
  runner: string;
  failureClass: AgentFailureClass;
  message: string;
  /** Explicit per-call runners fail here; outer fire failover must not replay. */
  explicitRunner?: boolean;
}

/** Preserve typed runner failure metadata through the handler worker boundary. */
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
      runner?: unknown;
      failureClass?: unknown;
      message?: unknown;
      explicitRunner?: unknown;
    };
    if (
      typeof parsed.runner !== "string" ||
      typeof parsed.failureClass !== "string" ||
      typeof parsed.message !== "string"
    ) {
      return undefined;
    }
    return {
      runner: parsed.runner,
      failureClass: parsed.failureClass as AgentFailureClass,
      message: parsed.message,
      ...(parsed.explicitRunner === true ? { explicitRunner: true } : {}),
    };
  } catch {
    return undefined;
  }
}

function agentFailureError(failure: AutomationAgentFailure): Error {
  return new Error(`${AGENT_FAILURE_PREFIX}${JSON.stringify(failure)}`);
}

/**
 * Stand up the live dispatch surface for the CLI runner. `ctx.agent` routes to
 * the user's REAL provider through the runner registry; everything else on the
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
  type AdapterState = {
    kind: string;
    sessionId?: string;
    usageSnapshot?: TypeImport_4y0tle.AdapterUsageSnapshot;
    hydrated?: boolean;
  };
  const latestAdapters = new Map<RunnerKind, AdapterState>();
  const observedAdapters = new Map<RunnerKind, AdapterState>();
  const successfulRunnerOrder: RunnerKind[] = [];
  let lastObservedRunner: RunnerKind | undefined;
  let hydrationTokens = 0;
  const ensureScratch = async (): Promise<void> => {
    if (scratchReady) return;
    await fs.mkdir(scratchDir, { recursive: true });
    scratchReady = true;
  };

  // Vault-derivative attachments (issue #299): the runner already resolved
  // and receipted them; here they become scratch files the agent's native
  // multimodal Read path picks up — one mechanism for every runner, no
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

  // ctx.agent routes to the user's REAL provider through the SAME runner
  // registry chat uses — one integration path for every kind (issue #479).
  // `runTurn` normalizes each agent's stream into TurnStreamEvents, so this
  // reads `final` / `error` and coerces the answer with no per-backend wire
  // format anywhere in this file.
  //
  // Two deliberate limits. (1) ACP has no `--output-schema` equivalent, so
  // `call.json` is enforced by `coerceAgentAnswer` alone. (2) A fire carries
  // only runner KINDS (a call may override the fire kind; the gateway never
  // carries binPath / extraArgs), so each backend resolves its binary from
  // per-kind prefs or PATH. The custom
  // `acp` kind has no default binary and therefore surfaces a clear `error`
  // event, raised below.
  const agentDispatcher: automation.AgentDispatcher = async (
    call,
    ctx
  ): Promise<unknown> => {
    const explicitRunner = call.runner !== undefined;
    if (
      explicitRunner &&
      (typeof call.runner !== "string" || !isRunnerKind(call.runner))
    ) {
      const named = String(call.runner);
      throw agentFailureError({
        runner: named,
        failureClass: "unknown",
        message: `Per-call automation runner "${named}" is not a registered harness.`,
        explicitRunner: true,
      });
    }
    const runner = explicitRunner ? (call.runner as RunnerKind) : opts.runner;
    if (
      call.model !== undefined &&
      (typeof call.model !== "string" || call.model.length === 0)
    ) {
      throw agentFailureError({
        runner,
        failureClass: "unknown",
        message: "Per-call automation model must be a non-empty string.",
        ...(explicitRunner ? { explicitRunner: true } : {}),
      });
    }
    if (
      call.model === "centraid-mock" ||
      call.model?.startsWith("centraid-mock/")
    ) {
      throw agentFailureError({
        runner,
        failureClass: "unknown",
        message: `Per-call automation model "${call.model}" points at the centraid-mock provider and would recurse into the automation runtime.`,
        ...(explicitRunner ? { explicitRunner: true } : {}),
      });
    }
    const model = call.model ?? opts.model;
    // Unattended egress is never prompted (#567 D5) — it is authorized at
    // authoring time. So derive the grant honestly rather than minting one:
    // `recordDerived` refuses to resurrect a revoked provider and refuses a
    // ladder source the user's live settings do not contain. A controller
    // without the derived-consent seam denies rather than assumes.
    const consent = opts.providerEgressConsent;
    const consentSource = explicitRunner
      ? opts.consentSourceFor
        ? opts.consentSourceFor(runner)
        : runner === opts.runner
          ? opts.consentSource
          : undefined
      : opts.consentSource;
    if (explicitRunner && consentSource === undefined) {
      throw agentFailureError({
        runner,
        failureClass: "unknown",
        message:
          `Unattended egress to ${runner} is not enrolled for ${opts.automationRef}. ` +
          `Add ${runner} to the automations agent or its failover ladder in Settings.`,
        explicitRunner: true,
      });
    }
    const hasConsent =
      consent?.has(opts.automationRef, runner, "automations") ?? false;
    if (consent && (explicitRunner || !hasConsent)) {
      const derived =
        consentSource === undefined
          ? false
          : (consent.recordDerived?.(
              opts.automationRef,
              runner,
              consentSource,
              "automations"
            ) ?? false);
      if (!derived) {
        throw agentFailureError({
          runner,
          failureClass: "unknown",
          message:
            `Unattended egress to ${runner} is not consented for ${opts.automationRef}. ` +
            `Add ${runner} to the automations agent or its failover ladder in Settings, ` +
            `or run this automation interactively and approve the provider.`,
          ...(explicitRunner ? { explicitRunner: true } : {}),
        });
      }
    }
    const staged = await stageAttachments(call);
    const scope = opts.runnerHealthContext ?? opts.workdir;
    const breaker = opts.runnerHealth?.canAttempt(scope, runner);
    if (breaker && !breaker.allowed) {
      throw agentFailureError({
        runner,
        failureClass: breaker.failureClass ?? "unknown",
        message: `Runner breaker is open${breaker.breakerUntil ? ` until ${new Date(breaker.breakerUntil).toISOString()}` : ""}.`,
        ...(explicitRunner ? { explicitRunner: true } : {}),
      });
    }
    const loaded = (await opts.runnerPrefsFor?.(runner)) ?? { kind: runner };
    const prefs: RunnerPrefs =
      loaded.kind === runner ? loaded : { kind: runner };
    const inheritedConfigPins =
      runner === opts.runner
        ? (opts.configPins ?? prefs.configPins)
        : prefs.configPins;
    // ACP resolves `configPins.model` before `input.model`. Mirror an explicit
    // call override into the pin map so a runner/subsystem preference cannot
    // silently win over the handler's step-level selection (#740).
    const configPins =
      call.model === undefined
        ? inheritedConfigPins
        : { ...inheritedConfigPins, model: call.model };
    let finalText = "";
    let failure: Extract<TurnStreamEvent, { type: "error" }> | undefined;
    const latestAdapter = latestAdapters.get(runner);
    const binding =
      latestAdapter?.sessionId === undefined
        ? runsStore.getHarnessBinding(opts.automationRef, runner)
        : undefined;
    const resumeSessionId = latestAdapter?.sessionId ?? binding?.acpSessionId;
    const resumeUsage = latestAdapter?.usageSnapshot ?? binding?.usageSnapshot;
    const completedTurns = runsStore.listTurns(opts.automationRef);
    const hydrationMessages =
      latestAdapter === undefined
        ? hydrationMessagesFromLedger(
            completedTurns,
            (turnId) => runsStore.listItems(turnId),
            (itemId) => runsStore.listAttachmentsForItem(itemId),
            binding?.hydratedThroughSeq ?? -1
          )
        : [];
    const recoveryMessages =
      latestAdapter === undefined && binding
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
          adapterKind: string;
          usageSnapshot?: TypeImport_4y0tle.AdapterUsageSnapshot;
          hydrated?: boolean;
          hydrationKind?: "handoff" | "recovery";
        }
      | undefined;
    let observedAdapter: AdapterState | undefined;
    try {
      result = await getRunnerBackend(runner).runTurn(
        {
          conversationId: opts.automationRef,
          cwd: opts.workdir,
          message: staged.prompt,
          ...(staged.attachments ? { attachments: staged.attachments } : {}),
          extraSystemPrompt: "",
          ...(model ? { model } : {}),
          ...(configPins ? { configPins } : {}),
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
      observedAdapter = {
        kind: result.adapterKind,
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        ...(result.usageSnapshot
          ? { usageSnapshot: result.usageSnapshot }
          : {}),
        ...(result.hydrated ? { hydrated: true } : {}),
      };
      observedAdapters.set(runner, observedAdapter);
      lastObservedRunner = runner;
      if (result.hydrated) {
        hydrationTokens +=
          result.hydrationKind === "recovery"
            ? (recoveryHydrationPlan?.estimatedTokens ?? 0)
            : (hydrationPlan?.estimatedTokens ?? 0);
      }
    }
    if (!failure) {
      if (observedAdapter) {
        latestAdapters.set(runner, observedAdapter);
        const previousIndex = successfulRunnerOrder.indexOf(runner);
        if (previousIndex >= 0) successfulRunnerOrder.splice(previousIndex, 1);
        successfulRunnerOrder.push(runner);
      }
      opts.runnerHealth?.reportOk(scope, runner);
      return automation.coerceAgentAnswer(finalText, call.json);
    }
    const typedFailure: AutomationAgentFailure = {
      runner,
      failureClass: failure.failureClass ?? "unknown",
      message: failure.message,
      ...(explicitRunner ? { explicitRunner: true } : {}),
    };
    opts.runnerHealth?.reportFailure(
      scope,
      runner,
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
      if (ok) {
        store.noteTurnWithAdapters(
          conversationId,
          "",
          successfulRunnerOrder.flatMap((runner) => {
            const adapter = latestAdapters.get(runner);
            return adapter ? [adapter] : [];
          })
        );
      } else {
        store.noteFailedTurn(
          conversationId,
          "",
          lastObservedRunner
            ? observedAdapters.get(lastObservedRunner)
            : undefined
        );
      }
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
