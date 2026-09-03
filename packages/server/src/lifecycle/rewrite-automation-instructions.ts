import { randomUUID } from "node:crypto";
import path from "node:path";

import type { Row as AutomationRow } from "@centraid/server/automation";
import { resolveItemCost, TurnPlane } from "@centraid/server/engine";
import type {
  HarnessPrefs,
  RunTurnFn,
  TurnStreamEvent,
} from "@centraid/server/engine";

import { ledgerConversationStore } from "../ledger-stores.js";

const REWRITE_SYSTEM = [
  "Rewrite one automation instruction document.",
  "Return only the complete revised instruction text, with no preface, quotes, or code fence.",
  "Honor the steering request while preserving all unaffected behavior, schedules, connector-account intent, and safety constraints.",
  "Do not invent permissions or credentials.",
].join(" ");

type UsageEvent = Extract<TurnStreamEvent, { type: "usage" }>;

function rewriteUsageFields(usage: UsageEvent | undefined): {
  model?: string;
  harness?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  costSource?: "harness" | "estimated";
} {
  if (!usage) return {};
  const cost =
    usage.costUsd === undefined
      ? resolveItemCost({
          model: usage.model,
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
          },
        })
      : {
          costUsd: usage.costUsd,
          costSource: usage.costSource ?? ("harness" as const),
        };
  return {
    ...(usage.model === undefined ? {} : { model: usage.model }),
    ...(usage.harness === undefined ? {} : { harness: usage.harness }),
    ...(usage.inputTokens === undefined
      ? {}
      : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined
      ? {}
      : { outputTokens: usage.outputTokens }),
    ...(usage.cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(cost.costUsd === undefined ? {} : { costUsd: cost.costUsd }),
    ...(cost.costSource === undefined ? {} : { costSource: cost.costSource }),
  };
}

export function rewriteWorkOrder(current: string, steering: string): string {
  return [
    "Current standing instructions:",
    current,
    "",
    "Steering request:",
    steering,
    "",
    "Complete revised instructions:",
  ].join("\n");
}

export function cleanRewrittenInstructions(raw: string): string | undefined {
  let text = raw.trim();
  text = text
    .replace(/^```(?:markdown|md|text)?\s*/iu, "")
    .replace(/\s*```$/iu, "");
  text = text.replace(/^revised instructions\s*:\s*/iu, "").trim();
  return text || undefined;
}

export interface RewriteAutomationInstructionsOptions {
  row: AutomationRow;
  steering: string;
  revisionTurnId?: string;
  ledgerDbFile: string;
  harnessSessionDir: string;
  runTurn: RunTurnFn;
  harnessPrefs: HarnessPrefs;
  model?: string;
  egressConsent: () => boolean | Promise<boolean>;
  persistPrompt: (prompt: string) => Promise<void>;
}

export interface RewriteAutomationInstructionsResult {
  revisionTurnId: string;
  prompt: string;
}

export async function rewriteAutomationInstructions(
  opts: RewriteAutomationInstructionsOptions
): Promise<RewriteAutomationInstructionsResult> {
  const store = ledgerConversationStore(opts.ledgerDbFile);
  const conversationId = store.ensureAutomationConversation(
    opts.row.ref,
    opts.row.ownerApp,
    opts.row.name,
    opts.harnessPrefs.kind
  );
  const revisionTurnId =
    opts.revisionTurnId ?? `${opts.row.ref}:revise:${randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  store.insertTurn({
    turnId: revisionTurnId,
    conversationId,
    triggerKind: "interactive",
    triggerOrigin: "manual",
    note: "Revising instructions",
    startedAt,
  });
  store.insertMessageIn({
    turnId: revisionTurnId,
    role: "user",
    text: opts.steering,
    startedAt,
  });

  let text = "";
  let error: string | undefined;
  let rawJson: string | undefined;
  let stopReason: string | undefined;
  let usage: UsageEvent | undefined;
  const onEvent = (event: TurnStreamEvent): void => {
    if (event.type === "assistant.delta") text += event.delta;
    if (event.type === "final") {
      text ||= event.text;
      rawJson = event.rawJson;
      stopReason = event.stopReason;
    }
    if (event.type === "error") {
      error = event.message;
      rawJson = event.rawJson;
      stopReason = event.stopReason;
    }
    if (event.type === "aborted") {
      error = "Instruction rewrite aborted.";
      stopReason = "cancelled";
    }
    if (event.type === "usage") usage = event;
  };

  try {
    const cwd = path.join(
      opts.harnessSessionDir,
      "automation-rewrites",
      randomUUID()
    );
    const turnPlane = new TurnPlane(opts.runTurn);
    await turnPlane.runTurn(
      {
        cwd,
        message: rewriteWorkOrder(opts.row.manifest.prompt, opts.steering),
        extraSystemPrompt: REWRITE_SYSTEM,
        ...(opts.model ? { model: opts.model } : {}),
        permissionPolicy: "deny",
        abortSignal: new AbortController().signal,
        onEvent,
      },
      opts.harnessPrefs,
      {
        surface: "interactive",
        egress: "attended",
        egressConsent: opts.egressConsent,
        failover: "none",
        permissionPolicy: "deny",
        artifacts: "delegate-only",
      }
    );
    if (error) throw new Error(error);
    const prompt = cleanRewrittenInstructions(text);
    if (!prompt)
      throw new Error("The instruction rewriter returned an empty result.");
    await opts.persistPrompt(prompt);

    const endedAt = Date.now();
    store.insertItem({
      itemId: randomUUID(),
      turnId: revisionTurnId,
      ordinal: 1,
      kind: "step",
      outputJson: JSON.stringify({
        text: "Revised instructions",
        ...(stopReason === undefined ? {} : { stopReason }),
      }),
      ...(rawJson === undefined ? {} : { rawJson }),
      ok: true,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      ...rewriteUsageFields(usage),
    });
    store.finishTurn({
      turnId: revisionTurnId,
      endedAt,
      ok: true,
      summary: "Revised instructions",
      outputJson: JSON.stringify({
        prompt,
        ...(stopReason === undefined ? {} : { stopReason }),
      }),
    });
    return { revisionTurnId, prompt };
  } catch (caughtError) {
    const message =
      caughtError instanceof Error ? caughtError.message : String(caughtError);
    const endedAt = Date.now();
    store.insertItem({
      itemId: randomUUID(),
      turnId: revisionTurnId,
      ordinal: 1,
      kind: "step",
      outputJson: JSON.stringify({
        error: message,
        ...(text ? { text } : {}),
        ...(stopReason === undefined ? {} : { stopReason }),
      }),
      ...(rawJson === undefined ? {} : { rawJson }),
      ok: false,
      error: message,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      ...rewriteUsageFields(usage),
    });
    store.finishTurn({
      turnId: revisionTurnId,
      endedAt,
      ok: false,
      error: message,
      summary: "Instruction revision failed",
      ...(stopReason === undefined
        ? {}
        : { outputJson: JSON.stringify({ stopReason, error: message }) }),
    });
    throw caughtError;
  }
}
