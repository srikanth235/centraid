// The harness-runtime wrapper over the fire spine (#98, #147): orchestration
// stays in `runFire`; this file injects the `ctx.delegate` surface. No
// `ctx.tool` rail (#484), so a handler that never delegates spawns nothing.

import { randomUUID } from "node:crypto";

import * as automation from "@centraid/server/automation";
import { isHarnessKind } from "@centraid/server/engine";
import type {
  AutomationTriggerKind,
  AutomationTriggerOrigin,
  AutomationTurnStreamEvent,
  ProviderEgressConsentController,
  HarnessHealthController,
  HarnessPrefs,
  RunTurnFn,
  VaultBridge,
} from "@centraid/server/engine";

import type { HarnessKind } from "../types.js";
import {
  parseAutomationDelegateFailure,
  startLiveDispatch,
} from "./run-automation-live-dispatch.js";

export interface RunAutomationOptions {
  automationRef: string;
  runId?: string;
  appsDir: string;
  /** The one per-vault run ledger (#280). */
  ledgerDbFile: string;
  /** Required: a fire must not construct an unmetered door. */
  runTurn: RunTurnFn;
  codeAppsDir?: string;
  vaultFor?: (
    appId: string,
    automationRef: string
  ) => VaultBridge | undefined | Promise<VaultBridge | undefined>;
  harness?: HarnessKind;
  /** Only `prefs` is consent for unattended egress; a manifest pin must be a
   *  live ladder member or carry a grant (#567). */
  harnessSelectionSource?: "prefs" | "manifest";
  /** Fallback only: the manifest's `requires.model` always wins. */
  model?: string;
  configPins?: Readonly<Record<string, string>>;
  harnessLadder?: readonly HarnessKind[];
  harnessPrefsFor?: (harness: HarnessKind) => Promise<HarnessPrefs | undefined>;
  harnessHealth?: HarnessHealthController;
  harnessHealthContext?: string;
  /** Required for unattended fires. */
  providerEgressConsent: ProviderEgressConsentController;
  hydrationAttachmentPath?: (hash: string) => string;
  onFailover?: (event: {
    automationRef: string;
    from: HarnessKind;
    to: HarnessKind;
    failureClass: string;
    failedRunId: string;
    nextRunId: string;
  }) => void;
  timeoutMs?: number;
  onLog?: (level: "info" | "warn" | "error", msg: string) => void;
  onRunEvent?: (ev: AutomationTurnStreamEvent) => void;
  rearm?: automation.RunFireOptions["rearm"];
  triggerKind?: AutomationTriggerKind;
  triggerOrigin?: AutomationTriggerOrigin;
  note?: string;
  input?: unknown;
  parentRunId?: string;
  /** Recursion guard: the runtime refuses to push the chain past depth 3. */
  failureDepth?: number;
  resolveConnection?: automation.ResolveConnection;
  /** The spine refuses `manifest.enrich` when this is absent. */
  resolveEnrichPolicy?: automation.RunFireOptions["resolveEnrichPolicy"];
  resolveNestedRuntime?: (automationRef: string) => Promise<{
    harnessKind?: HarnessKind;
    model?: string;
    configPins?: Readonly<Record<string, string>>;
  }>;
}

/** A missing app throws; a handler failure is `outcome.ok === false`. */
export async function runAutomation(opts: RunAutomationOptions): Promise<{
  outcome: automation.HandlerOutcome;
  record: automation.RunRecord;
}> {
  const primary: HarnessKind = opts.harness ?? "codex";
  const ladder: HarnessKind[] = [];
  for (const kind of [primary, ...(opts.harnessLadder ?? [])]) {
    if (!ladder.includes(kind)) ladder.push(kind);
  }
  const baseRunId =
    opts.runId ??
    `${opts.automationRef}:${Date.now()}:${randomUUID().slice(0, 8)}`;
  let last:
    | { outcome: automation.HandlerOutcome; record: automation.RunRecord }
    | undefined;
  let failoverNotice: string | undefined;
  const condemned: string[] = [];

  const runRung = async (index: number): Promise<void> => {
    const harness = ladder[index]!;
    const isPrimary = index === 0;
    // A known-open breaker is decided BEFORE the handler runs: by the time
    // `ctx.delegate` checks, side effects have landed and the next rung replays
    // them.
    if (opts.harnessHealthContext && opts.harnessHealth) {
      const breaker = opts.harnessHealth.canAttempt(
        opts.harnessHealthContext,
        harness
      );
      if (!breaker.allowed) {
        const reason =
          `${harness} is circuit-broken (${breaker.failureClass ?? "unknown"})` +
          `${breaker.breakerUntil ? ` until ${new Date(breaker.breakerUntil).toISOString()}` : ""}`;
        condemned.push(reason);
        const next = ladder[index + 1];
        opts.onLog?.(
          "warn",
          `${reason}; skipping it for ${opts.automationRef}` +
            `${next ? ` and continuing with ${next}` : ""}`
        );
        failoverNotice = next
          ? `${reason}. Skipped without running the handler; continuing with ${next}.`
          : undefined;
        if (next) {
          opts.onFailover?.({
            automationRef: opts.automationRef,
            from: harness,
            to: next,
            failureClass: breaker.failureClass ?? "unknown",
            failedRunId:
              index === 0
                ? baseRunId
                : `${baseRunId}:failover:${index}:${harness}`,
            nextRunId: `${baseRunId}:failover:${index + 1}:${next}`,
          });
          return runRung(index + 1);
        }
        return;
      }
    }
    const prefs = await opts.harnessPrefsFor?.(harness);
    const model = isPrimary ? opts.model : undefined;
    const configPins = isPrimary ? opts.configPins : prefs?.configPins;
    const runId =
      index === 0 ? baseRunId : `${baseRunId}:failover:${index}:${harness}`;
    const openDispatch: automation.OpenDispatch = (args) =>
      startLiveDispatch({
        workdir: args.workdir,
        runId: args.runId,
        automationRef: args.automationRef,
        ledgerDbFile: opts.ledgerDbFile,
        runTurn: opts.runTurn,
        harness: isHarnessKind(args.harnessKind) ? args.harnessKind : harness,
        // Provider-specific owner pins are cleared after the first rung.
        ...((args.model ?? model) ? { model: args.model ?? model } : {}),
        ...((args.configPins ?? configPins)
          ? { configPins: args.configPins ?? configPins }
          : {}),
        ...(opts.harnessPrefsFor
          ? { harnessPrefsFor: opts.harnessPrefsFor }
          : {}),
        ...(opts.harnessHealth ? { harnessHealth: opts.harnessHealth } : {}),
        ...(opts.harnessHealthContext
          ? { harnessHealthContext: opts.harnessHealthContext }
          : {}),
        providerEgressConsent: opts.providerEgressConsent,
        ...(opts.hydrationAttachmentPath
          ? { hydrationAttachmentPath: opts.hydrationAttachmentPath }
          : {}),
        // A manifest-pinned primary is not user-authored consent: it egresses
        // only if the live ladder holds that harness.
        consentSource:
          isPrimary && opts.harnessSelectionSource !== "manifest"
            ? "direct"
            : "ladder",
        onLog: args.onLog,
      });

    const turnNote = [failoverNotice, opts.note]
      .filter((part) => !!part)
      .join(" ");

    last = await automation.runFire(
      {
        automationRef: opts.automationRef,
        runId,
        appsDir: opts.appsDir,
        ledgerDbFile: opts.ledgerDbFile,
        ...(opts.codeAppsDir ? { codeAppsDir: opts.codeAppsDir } : {}),
        ...(opts.vaultFor ? { vaultFor: opts.vaultFor } : {}),
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.onLog ? { onLog: opts.onLog } : {}),
        harnessKind: harness,
        ...(model ? { model } : {}),
        ...(configPins ? { configPins } : {}),
        allowManifestProviderPins: isPrimary,
        ...(opts.onRunEvent ? { onRunEvent: opts.onRunEvent } : {}),
        ...(opts.rearm ? { rearm: opts.rearm } : {}),
        ...(opts.triggerKind ? { triggerKind: opts.triggerKind } : {}),
        ...(opts.triggerOrigin ? { triggerOrigin: opts.triggerOrigin } : {}),
        // The caller's note stays on every rung; a failover notice is additive.
        ...(turnNote ? { note: turnNote } : {}),
        ...(failoverNotice ? { failoverNotice } : {}),
        ...(opts.input === undefined ? {} : { input: opts.input }),
        ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
        ...(opts.failureDepth === undefined
          ? {}
          : { failureDepth: opts.failureDepth }),
        ...(opts.resolveConnection
          ? { resolveConnection: opts.resolveConnection }
          : {}),
        ...(opts.resolveEnrichPolicy
          ? { resolveEnrichPolicy: opts.resolveEnrichPolicy }
          : {}),
        ...(opts.resolveNestedRuntime
          ? { resolveNestedRuntime: opts.resolveNestedRuntime }
          : {}),
        deferOnFailure: (outcome) => {
          const failure = parseAutomationDelegateFailure(outcome.error);
          return (
            index < ladder.length - 1 &&
            failure !== undefined &&
            failure.explicitHarness !== true
          );
        },
      },
      { openDispatch }
    );

    const failure = parseAutomationDelegateFailure(last.outcome.error);
    const next = ladder[index + 1];
    if (!failure || failure.explicitHarness || !next) return;
    const nextRunId = `${baseRunId}:failover:${index + 1}:${next}`;
    opts.onLog?.(
      "warn",
      `${harness} failed at automation fire boundary (${failure.failureClass}); ` +
        `re-entering ${opts.automationRef} with ${next} as ${nextRunId}`
    );
    failoverNotice =
      `${harness} failed at the automation fire boundary (${failure.failureClass}). ` +
      `Continuing with ${next}; provider-specific model and effort pins were cleared.`;
    opts.onFailover?.({
      automationRef: opts.automationRef,
      from: harness,
      to: next,
      failureClass: failure.failureClass,
      failedRunId: runId,
      nextRunId,
    });
    return runRung(index + 1);
  };
  await runRung(0);

  if (!last) {
    // Throw, so the caller keeps its "failed before the ledger opened" path
    // rather than inventing a record for work that never started.
    throw new Error(
      `automation ${opts.automationRef}: no harness available — ${condemned.join("; ")}`
    );
  }
  return last;
}
