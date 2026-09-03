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
  ledgerDbFile: string;
  runTurn: RunTurnFn;
  codeAppsDir?: string;
  vaultFor?: (
    appId: string,
    automationRef: string
  ) => VaultBridge | undefined | Promise<VaultBridge | undefined>;
  harness?: HarnessKind;
  harnessSelectionSource?: "prefs" | "manifest";
  model?: string;
  configPins?: Readonly<Record<string, string>>;
  harnessLadder?: readonly HarnessKind[];
  harnessPrefsFor?: (harness: HarnessKind) => Promise<HarnessPrefs | undefined>;
  harnessHealth?: HarnessHealthController;
  harnessHealthContext?: string;
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
  failureDepth?: number;
  resolveConnection?: automation.ResolveConnection;
  resolveEnrichPolicy?: automation.RunFireOptions["resolveEnrichPolicy"];
  resolveNestedRuntime?: (automationRef: string) => Promise<{
    harnessKind?: HarnessKind;
    model?: string;
    configPins?: Readonly<Record<string, string>>;
  }>;
}

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
    throw new Error(
      `automation ${opts.automationRef}: no harness available — ${condemned.join("; ")}`
    );
  }
  return last;
}
