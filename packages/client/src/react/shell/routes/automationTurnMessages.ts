import type {
  AsstMsgDTO,
  AsstToolCallDTO,
  AsstUsageDTO,
} from "../../screen-contracts.js";
import { richAnswerHtml } from "./assistantRich.js";

export function itemText(json: string | undefined, fallback = ""): string {
  if (!json) return fallback;
  try {
    const value = JSON.parse(json) as unknown;
    if (typeof value === "string") return value;
    if (
      value &&
      typeof value === "object" &&
      typeof (value as { text?: unknown }).text === "string"
    ) {
      return (value as { text: string }).text;
    }
    return JSON.stringify(value, null, 2);
  } catch {
    return json;
  }
}

export function stopReasonIn(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const reason = (value as { stopReason?: unknown }).stopReason;
  return typeof reason === "string" && reason ? reason : undefined;
}

export function stopReasonFromJson(
  json: string | undefined
): string | undefined {
  if (!json) return undefined;
  try {
    return stopReasonIn(JSON.parse(json));
  } catch {
    return undefined;
  }
}

export function stopReasonForItem(
  item: CentraidAutomationItem
): string | undefined {
  return (
    stopReasonFromJson(item.outputJson) ?? stopReasonFromJson(item.rawJson)
  );
}

function stopReasonText(reason: string): string | undefined {
  if (reason === "end_turn") return undefined;
  if (reason === "max_tokens") {
    return "The harness hit its output token limit before finishing — the reply may be incomplete.";
  }
  if (reason === "max_turn_requests") {
    return "The harness hit its max turn/request limit before finishing — the reply may be incomplete.";
  }
  if (reason === "refusal") return "The harness refused to complete this turn.";
  if (reason === "cancelled")
    return "The harness stopped this turn (cancelled).";
  return `The harness ended the turn with stopReason “${reason}”.`;
}

export function stopReasonBubble(
  reason: string | undefined,
  turnId?: string,
  createdAt?: number
): Extract<AsstMsgDTO, { kind: "ai"; streaming: false }> | undefined {
  const text = reason ? stopReasonText(reason) : undefined;
  if (!text) return undefined;
  return {
    kind: "ai",
    streaming: false,
    html: richAnswerHtml(text),
    error: true,
    copyText: text,
    feedback: null,
    ...(turnId ? { turnId } : {}),
    ...(createdAt === undefined ? {} : { createdAt }),
  };
}

export function usageForItem(
  item: CentraidAutomationItem
): AsstUsageDTO | undefined {
  if (
    item.inputTokens === undefined &&
    item.outputTokens === undefined &&
    item.costUsd === undefined &&
    item.model === undefined
  ) {
    return undefined;
  }
  return {
    ...(item.inputTokens === undefined
      ? {}
      : { inputTokens: item.inputTokens }),
    ...(item.outputTokens === undefined
      ? {}
      : { outputTokens: item.outputTokens }),
    ...(item.costUsd === undefined ? {} : { costUsd: item.costUsd }),
    ...(item.costSource === "estimated" ? { estimated: true } : {}),
    ...(item.model === undefined ? {} : { model: item.model }),
  };
}

export const COMPILE_TURN_INBOUND_TEXT =
  "Apply the revised standing instructions.";

export function automationTurnInboundText(
  turn: { triggerKind?: CentraidAutomationTurnRecord["triggerKind"] } | null,
  items: readonly CentraidAutomationItem[]
): string {
  if (turn?.triggerKind === "compile") return COMPILE_TURN_INBOUND_TEXT;
  return items.find((item) => item.kind === "message_in")?.text ?? "";
}

export function toolLabel(calls: readonly AsstToolCallDTO[]): string {
  const running = calls.some((entry) => entry.state === "run");
  const failed = calls.filter((entry) => entry.state === "error").length;
  return running
    ? "using tools…"
    : `${calls.length} ${calls.length === 1 ? "tool" : "tools"}${failed ? ` · ${failed} failed` : ""}`;
}

export function automationTurnMessages(
  turn: CentraidAutomationTurnRecord,
  items: readonly CentraidAutomationItem[],
  liveText: ReadonlyMap<number, string> = new Map()
): AsstMsgDTO[] {
  const messages: AsstMsgDTO[] = [];
  let calls: AsstToolCallDTO[] = [];
  let callIndex = new Map<string, number>();
  let callsAnchor: string | undefined;
  const flushTools = (): void => {
    if (calls.length > 0) {
      messages.push({
        kind: "tools",
        label: toolLabel(calls),
        calls,
        msgId: `${callsAnchor ?? turn.turnId}:tools`,
      });
    }
    calls = [];
    callIndex = new Map();
    callsAnchor = undefined;
  };
  let pendingDelegate: CentraidAutomationItem | undefined;
  let answers = 0;
  const flushDelegate = (): void => {
    const item = pendingDelegate;
    if (!item) return;
    pendingDelegate = undefined;
    answers++;
    const live = liveText.get(item.ordinal) ?? "";
    if (item.endedAt === undefined) {
      messages.push({
        kind: "ai",
        streaming: true,
        text: live,
        msgId: `${item.itemId}:ai`,
      });
      return;
    }
    const text = item.ok
      ? itemText(item.outputJson, live)
      : (item.error ?? itemText(item.outputJson, "The delegation failed."));
    const usage = usageForItem(item);
    messages.push({
      kind: "ai",
      streaming: false,
      html: richAnswerHtml(text),
      error: !item.ok,
      copyText: text,
      createdAt: item.endedAt,
      turnId: turn.turnId,
      feedback: null,
      msgId: `${item.itemId}:ai`,
      ...(usage ? { usage } : {}),
    });
    const stop = stopReasonBubble(
      stopReasonForItem(item),
      turn.turnId,
      item.endedAt
    );
    if (stop && (item.ok || stop.copyText !== text)) {
      messages.push({ ...stop, msgId: `${item.itemId}:stop` });
    }
  };
  const flushToolsThenDelegate = (): void => {
    flushTools();
    flushDelegate();
  };
  const ordered = items.toSorted(
    (left, right) =>
      left.ordinal - right.ordinal || left.startedAt - right.startedAt
  );
  for (const item of ordered) {
    if (item.kind === "message_in") {
      flushToolsThenDelegate();
      messages.push({
        kind: "user",
        text:
          turn.triggerKind === "compile"
            ? COMPILE_TURN_INBOUND_TEXT
            : (item.text ?? ""),
        createdAt: item.startedAt,
        msgId: `${item.itemId}:in`,
      });
      continue;
    }
    if (item.kind === "delegate") {
      flushToolsThenDelegate();
      pendingDelegate = item;
      continue;
    }
    if (item.kind === "tool") {
      if (
        pendingDelegate?.endedAt !== undefined &&
        item.startedAt > pendingDelegate.endedAt
      ) {
        flushToolsThenDelegate();
      }
      const key = item.callId ?? item.itemId;
      const state =
        item.endedAt === undefined ? "run" : item.ok ? "ok" : "error";
      const call: AsstToolCallDTO = {
        tool: item.name ?? "tool",
        state,
        meta:
          state === "run"
            ? "running…"
            : state === "error"
              ? (item.error ?? "failed")
              : item.durationMs === undefined
                ? "completed"
                : `${item.durationMs}ms`,
      };
      const prior = callIndex.get(key);
      if (prior === undefined) {
        callsAnchor ??= item.itemId;
        callIndex.set(key, calls.push(call) - 1);
      } else {
        calls[prior] = call;
      }
      continue;
    }
    flushToolsThenDelegate();
    if (item.kind !== "step") continue;
    answers++;
    const live = liveText.get(item.ordinal) ?? "";
    if (item.endedAt === undefined) {
      messages.push({
        kind: "ai",
        streaming: true,
        text: live,
        msgId: `${item.itemId}:ai`,
      });
      continue;
    }
    const text = item.ok
      ? itemText(item.outputJson, live)
      : (item.error ?? itemText(item.outputJson, "The delegation failed."));
    const usage = usageForItem(item);
    messages.push({
      kind: "ai",
      streaming: false,
      html: richAnswerHtml(text),
      error: !item.ok,
      copyText: text,
      createdAt: item.endedAt,
      turnId: turn.turnId,
      feedback: null,
      msgId: `${item.itemId}:ai`,
      ...(usage ? { usage } : {}),
    });
    const stop = stopReasonBubble(
      stopReasonForItem(item),
      turn.turnId,
      item.endedAt
    );
    if (stop && (item.ok || stop.copyText !== text)) {
      messages.push({ ...stop, msgId: `${item.itemId}:stop` });
    }
  }
  flushToolsThenDelegate();

  if (answers === 0 && turn.endedAt !== undefined) {
    const text = turn.ok
      ? itemText(turn.outputJson, turn.summary ?? "The automation completed.")
      : (turn.error ?? "The automation did not complete.");
    messages.push({
      kind: "ai",
      streaming: false,
      html: richAnswerHtml(text),
      error: !turn.ok,
      copyText: text,
      createdAt: turn.endedAt,
      turnId: turn.turnId,
      feedback: turn.feedback ?? null,
      msgId: `${turn.turnId}:summary`,
    });
  }
  return messages;
}
