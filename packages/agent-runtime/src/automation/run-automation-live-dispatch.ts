/*
 * Live `ctx.delegate` dispatch for the local automation harness.
 *
 * Split out of `run-automation.ts` so that file can stay focused on the
 * per-fire lifecycle (manifest load, audit store, onFailure cascade). This
 * module owns the one billed rail — `ctx.delegate`, a bounded one-shot turn
 * against the user's real provider.
 *
 * Issue #743 — `ctx.delegate` honours every registered harness kind through
 * the same injected, accounted TurnPlane seam as chat. Pinning
 * `harness.automations` to any kind actually drives that harness.
 *
 * Issue #484 — the `ctx.tool` rail was removed. It used to dispatch tool
 * batches to a persistent mock-LLM session that puppeted the claude/codex
 * CLIs; that mock HTTP server started eagerly per fire even when unused. It
 * is gone. A fire whose handler never calls `ctx.delegate` now starts ZERO child
 * processes and ZERO HTTP servers: the deterministic rails (`ctx.vault`,
 * `ctx.fetch`, `ctx.state`, `ctx.runs`) are serviced in-process, parent-side.
 * The only thing this surface allocates lazily is a scratch dir — and only
 * when a `ctx.delegate` call actually carries vault-derivative attachments.
 *
 * Issue #91: an automation is a standalone app — the harness runs with the app
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
  RunTurnFn,
  TurnStreamEvent,
} from "@centraid/app-engine";
import {
  ConversationStore,
  HarnessSessions,
  hydrationMessagesFromLedger,
  isHarnessKind,
  makeJournalDbProvider,
  TurnPlane,
} from "@centraid/app-engine";
import * as automation from "@centraid/automation";

export interface LiveDispatchOptions {
  /** The automation app directory — also the harness's cwd. */
  workdir: string;
  runId: string;
  /** Stable automation conversation identity (`<appId>/<automationId>`). */
  automationRef: string;
  /** Canonical per-vault ledger holding harness bindings and hydration watermarks. */
  journalDbFile: string;
  /** Host-accounted dispatch seam. No automation may reach a harness directly. */
  runTurn: RunTurnFn;
  harness: HarnessKind;
  /**
   * Model id/alias for `ctx.delegate` calls (manifest `requires.model`, or the
   * caller's prefs-resolved fallback — see `RunAutomationOptions.model`).
   * Undefined means "no override" — the harness's own default applies.
   */
  model?: string;
  /** Semantic ACP configuration pins, keyed by capability category. */
  configPins?: Readonly<Record<string, string>>;
  /** Load launch settings/default config for this fire's selected harness. */
  harnessPrefsFor?: (harness: HarnessKind) => Promise<HarnessPrefs | undefined>;
  harnessHealth?: HarnessHealthController;
  harnessHealthContext?: string;
  /** Required fail-closed controller for every unattended provider egress. */
  providerEgressConsent: ProviderEgressConsentController;
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
  delegateDispatcher: automation.DelegateDispatcher;
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

const DELEGATE_FAILURE_PREFIX = "centraid-delegate-failure:";

export interface AutomationDelegateFailure {
  harness: string;
  failureClass: HarnessFailureClass;
  message: string;
  explicitHarness?: boolean;
}

/** Preserve typed harness failure metadata through the handler worker boundary. */
export function parseAutomationDelegateFailure(
  error: string | undefined
): AutomationDelegateFailure | undefined {
  if (!error) return undefined;
  const at = error.indexOf(DELEGATE_FAILURE_PREFIX);
  if (at < 0) return undefined;
  try {
    // Handler workers preserve the original error text but append their own
    // stack after a newline. The structured marker is deliberately one
    // JSON-encoded line (embedded newlines in `message` are escaped), so only
    // parse that line instead of letting a worker stack suppress failover.
    const payload = error
      .slice(at + DELEGATE_FAILURE_PREFIX.length)
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
    return parsed as AutomationDelegateFailure;
  } catch {
    return undefined;
  }
}

function delegateFailureError(failure: AutomationDelegateFailure): Error {
  return new Error(`${DELEGATE_FAILURE_PREFIX}${JSON.stringify(failure)}`);
}

/**
 * Stand up the live dispatch surface for the CLI harness. `ctx.delegate` routes to
 * the user's REAL provider through the harness registry; everything else on the
 * `ctx.*` surface is deterministic and serviced parent-side, so this allocates
 * nothing eagerly. The scratch dir is created lazily, only when a `ctx.delegate`
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
  const harnessSessions = new HarnessSessions({
    binding: (kind) => {
      const binding = runsStore.getHarnessBinding(opts.automationRef, kind);
      return binding
        ? {
            bindingId: binding.id,
            sessionId: binding.acpSessionId,
            ...(binding.usageSnapshot
              ? { usageSnapshot: binding.usageSnapshot }
              : {}),
            hydratedThroughSeq: binding.hydratedThroughSeq,
          }
        : undefined;
    },
    messages: (afterSeq) =>
      hydrationMessagesFromLedger(
        runsStore.listTurns(opts.automationRef),
        (turnId) => runsStore.listItems(turnId),
        (itemId) => runsStore.listAttachmentsForItem(itemId),
        afterSeq
      ),
    ...(opts.hydrationAttachmentPath
      ? { attachmentPath: opts.hydrationAttachmentPath }
      : {}),
  });
  const turnPlane = new TurnPlane(opts.runTurn);
  const ensureScratch = async (): Promise<void> => {
    if (scratchReady) return;
    await fs.mkdir(scratchDir, { recursive: true });
    scratchReady = true;
  };

  // Vault-derivative attachments (issue #299): the harness already resolved
  // and receipted them; here they become scratch files the harness's native
  // multimodal Read path picks up — one mechanism for every harness, no
  // per-harness wire format. The scratch dir materializes only on first use.
  const stageAttachments = async (
    call: automation.DelegateCall
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

  // ctx.delegate routes to the user's provider through the SAME accounted
  // TurnPlane door chat uses — one integration path for every harness.
  // `runTurn` normalizes each harness's stream into TurnStreamEvents, so this
  // reads `final` / `error` and coerces the answer with no per-harness wire
  // format anywhere in this file.
  //
  // Two deliberate limits. (1) ACP has no `--output-schema` equivalent, so
  // `call.json` is enforced by `coerceDelegateAnswer` alone. (2) A fire carries
  // only the harness KIND (the gateway drops binPath / extraArgs for every
  // kind), so the harness resolves its default binary off PATH. The custom
  // `acp` kind has no default binary and therefore surfaces a clear `error`
  // event, raised below.
  const delegateDispatcher: automation.DelegateDispatcher = async (
    call,
    ctx
  ): Promise<unknown> => {
    const explicitHarness = call.harness !== undefined;
    if (call.harness !== undefined && !isHarnessKind(call.harness)) {
      throw delegateFailureError({
        harness: call.harness,
        failureClass: "unknown",
        message: `Unknown harness "${call.harness}" requested by ctx.delegate.`,
        explicitHarness: true,
      });
    }
    const harness = call.harness ?? opts.harness;
    // Unattended egress is never prompted (#567 D5) — it is authorized at
    // authoring time. So derive the grant honestly rather than minting one:
    // `recordDerived` refuses to resurrect a revoked provider and refuses a
    // ladder source the user's live settings do not contain. A controller
    // without the derived-consent seam denies rather than assumes.
    const consent = opts.providerEgressConsent;
    // Defense in depth for untyped JavaScript callers: the public TypeScript
    // contract requires this controller, but a missing host dependency must
    // still deny before attachments are staged or a harness is reached.
    if (!consent) {
      throw delegateFailureError({
        harness,
        failureClass: "unknown",
        message:
          `Unattended egress to ${harness} is unavailable for ${opts.automationRef}: ` +
          "the host did not provide a provider-egress consent controller.",
        ...(explicitHarness ? { explicitHarness: true } : {}),
      });
    }
    if (!consent.has(opts.automationRef, harness, "automations")) {
      const derived =
        (harness === opts.harness ? opts.consentSource : "ladder") === undefined
          ? false
          : (consent.recordDerived?.(
              opts.automationRef,
              harness,
              harness === opts.harness ? opts.consentSource! : "ladder",
              "automations"
            ) ?? false);
      if (!derived) {
        throw delegateFailureError({
          harness,
          failureClass: "unknown",
          message:
            `Unattended egress to ${harness} is not consented for ${opts.automationRef}. ` +
            `Add ${harness} to the automations harness or its failover ladder in Settings, ` +
            `or run this automation interactively and approve the provider.`,
          ...(explicitHarness ? { explicitHarness: true } : {}),
        });
      }
    }
    const staged = await stageAttachments(call);
    const scope = opts.harnessHealthContext ?? opts.workdir;
    const breaker = opts.harnessHealth?.canAttempt(scope, harness);
    if (breaker && !breaker.allowed) {
      throw delegateFailureError({
        harness,
        failureClass: breaker.failureClass ?? "unknown",
        message: `Harness breaker is open${breaker.breakerUntil ? ` until ${new Date(breaker.breakerUntil).toISOString()}` : ""}.`,
        ...(explicitHarness ? { explicitHarness: true } : {}),
      });
    }
    const loaded = (await opts.harnessPrefsFor?.(harness)) ?? { kind: harness };
    const prefs: HarnessPrefs =
      loaded.kind === harness ? loaded : { kind: harness };
    let finalText = "";
    let failure: Extract<TurnStreamEvent, { type: "error" }> | undefined;
    const plan = harnessSessions.plan(harness);
    const effectiveModel =
      call.model ?? (harness === opts.harness ? opts.model : undefined);
    const effectiveConfigPins = {
      ...prefs.configPins,
      ...(harness === opts.harness ? opts.configPins : {}),
      ...call.configPins,
    };
    let result:
      | {
          sessionId?: string;
          harnessKind: string;
          usageSnapshot?: import("@centraid/app-engine").HarnessUsageSnapshot;
          hydrated?: boolean;
          hydrationKind?: "handoff" | "recovery";
        }
      | undefined;
    try {
      result = await turnPlane.runTurn(
        {
          conversationId: opts.automationRef,
          cwd: opts.workdir,
          message: staged.prompt,
          ...(staged.attachments ? { attachments: staged.attachments } : {}),
          extraSystemPrompt: "",
          ...(effectiveModel ? { model: effectiveModel } : {}),
          ...(Object.keys(effectiveConfigPins).length > 0
            ? { configPins: effectiveConfigPins }
            : {}),
          abortSignal: ctx.abortSignal,
          ...(plan.sessionId ? { prevSessionId: plan.sessionId } : {}),
          ...(plan.usageSnapshot
            ? { prevUsageSnapshot: plan.usageSnapshot }
            : {}),
          ...(plan.hydrationContext
            ? {
                hydrationContext: plan.hydrationContext.prompt,
                forceHydration: true,
              }
            : {}),
          ...(plan.hydrationAttachments?.length
            ? { hydrationAttachments: plan.hydrationAttachments }
            : {}),
          ...(plan.recoveryHydrationContext
            ? {
                recoveryHydrationContext: plan.recoveryHydrationContext.prompt,
              }
            : {}),
          ...(plan.recoveryHydrationAttachments?.length
            ? {
                recoveryHydrationAttachments: plan.recoveryHydrationAttachments,
              }
            : {}),
          onEvent: (event) => {
            if (event.type === "final") finalText = event.text;
            if (event.type === "error") failure = event;
            call.onEvent?.(event);
          },
        },
        prefs,
        {
          surface: "automation",
          egress: "unattended",
          egressConsent: () =>
            consent.has(opts.automationRef, harness, "automations"),
          failover: explicitHarness ? "none" : "fire-boundary",
          permissionPolicy: "deny",
          artifacts: "delegate-only",
        }
      );
    } catch (error) {
      failure = {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        failureClass: "unknown",
      };
    }
    if (result) {
      const resultKind = isHarnessKind(result.harnessKind)
        ? result.harnessKind
        : harness;
      harnessSessions.observe(
        {
          kind: resultKind,
          ...(result.sessionId ? { sessionId: result.sessionId } : {}),
          ...(result.usageSnapshot
            ? { usageSnapshot: result.usageSnapshot }
            : {}),
          ...(result.hydrated ? { hydrated: true } : {}),
        },
        result.hydrationKind
      );
    }
    if (!failure) {
      opts.harnessHealth?.reportOk(scope, harness);
      return automation.coerceDelegateAnswer(finalText, call.json);
    }
    const typedFailure: AutomationDelegateFailure = {
      harness,
      failureClass: failure.failureClass ?? "unknown",
      message: failure.message,
      ...(explicitHarness ? { explicitHarness: true } : {}),
    };
    opts.harnessHealth?.reportFailure(
      scope,
      harness,
      typedFailure.failureClass,
      typedFailure.message
    );
    throw delegateFailureError(typedFailure);
  };

  let closed = false;
  return {
    delegateDispatcher,
    finalizeTurn(store, conversationId, turnId, ok): void {
      const hydrationTokens = harnessSessions.consumedHydrationTokens();
      if (hydrationTokens > 0) {
        store.setTurnHydrationTokens(turnId, hydrationTokens);
      }
      const observations = harnessSessions.allObservations();
      const finalObservation = harnessSessions.lastObservation();
      if (ok) {
        store.noteTurn(conversationId, "", finalObservation);
        for (const observation of observations) {
          if (observation !== finalObservation) {
            store.settleAdditionalHarness(conversationId, observation);
          }
        }
      } else {
        store.noteFailedTurn(conversationId, "", finalObservation);
        for (const observation of observations) {
          if (observation !== finalObservation) {
            store.settleAdditionalFailedHarness(conversationId, observation);
          }
        }
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
