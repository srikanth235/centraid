// Live `ctx.delegate` dispatch: the one billed rail, through the same accounted
// TurnPlane seam chat uses (#743). A fire that never calls `ctx.delegate` must
// start ZERO child processes and ZERO HTTP servers — every other `ctx.*` rail is
// serviced parent-side and the scratch dir is lazy (#484). cwd is the app (#91).

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import * as automation from "@centraid/server/automation";
import type {
  HarnessFailureClass,
  ProviderConsentSource,
  ProviderEgressConsentController,
  HarnessHealthController,
  HarnessKind,
  HarnessPrefs,
  RunTurnFn,
  TurnStreamEvent,
} from "@centraid/server/engine";
import {
  ConversationStore,
  HarnessSessions,
  hydrationMessagesFromLedger,
  isHarnessKind,
  makeJournalDbProvider,
  TurnPlane,
} from "@centraid/server/engine";

export interface LiveDispatchOptions {
  /** The automation app directory — also the harness's cwd. */
  workdir: string;
  runId: string;
  /** `<appId>/<automationId>`. */
  automationRef: string;
  journalDbFile: string;
  /** Host-accounted dispatch seam. No automation may reach a harness directly. */
  runTurn: RunTurnFn;
  harness: HarnessKind;
  /** Undefined means no override — the harness's own default applies. */
  model?: string;
  configPins?: Readonly<Record<string, string>>;
  harnessPrefsFor?: (harness: HarnessKind) => Promise<HarnessPrefs | undefined>;
  harnessHealth?: HarnessHealthController;
  harnessHealthContext?: string;
  /** Required fail-closed controller for every unattended provider egress. */
  providerEgressConsent: ProviderEgressConsentController;
  /** How the user authored this rung's harness (#567). Omit for a source the
   *  user did not author, so the fire is denied without a real grant. */
  consentSource?: ProviderConsentSource;
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
  /** Safe to call once. */
  close: () => Promise<void>;
}

const DELEGATE_FAILURE_PREFIX = "centraid-delegate-failure:";

export interface AutomationDelegateFailure {
  harness: string;
  failureClass: HarnessFailureClass;
  message: string;
  explicitHarness?: boolean;
}

/** Preserves typed failure metadata across the handler worker boundary. */
export function parseAutomationDelegateFailure(
  error: string | undefined
): AutomationDelegateFailure | undefined {
  if (!error) return undefined;
  const at = error.indexOf(DELEGATE_FAILURE_PREFIX);
  if (at < 0) return undefined;
  try {
    // Workers append a stack after a newline; the marker is one JSON line, so
    // parse only that or the stack suppresses failover.
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

/** Allocates nothing eagerly; the scratch dir is created on first stage. */
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

  // Vault derivatives (#299) become scratch files for the harness's Read path.
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

  // Two limits: ACP has no `--output-schema`, so `call.json` rests on
  // `coerceDelegateAnswer`; and a fire carries only the harness KIND.
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
    // Unattended egress is never prompted (#567): derive the grant, never mint
    // one. A controller without the derived-consent seam denies.
    const consent = opts.providerEgressConsent;
    // Untyped JS callers can still omit it; deny before anything is staged.
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
          usageSnapshot?: import("@centraid/server/engine").HarnessUsageSnapshot;
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
        // `finalizeTurn` owns binding/watermark settlement; close only frees
        // process-local resources.
      } finally {
        clearInterval(lockLeaseHeartbeat);
        runsStore.releaseTurnLock(opts.automationRef, lockToken);
        runsStore.close();
      }
      // An attachment-free fire must touch no disk here.
      if (scratchReady) {
        await fs
          .rm(scratchDir, { recursive: true, force: true })
          .catch(() => undefined);
      }
    },
  };
}
