import type { Attachment, Item, Turn } from "./schema.js";

export interface HydrationMessage {
  payload: unknown;
  createdAt?: number;
}

export interface HydrationPlan {
  prompt: string;
  includedTurns: number;
  omittedTurns: number;
  estimatedTokens: number;
  attachments: HydrationAttachmentReference[];
}

export interface HydrationAttachmentReference {
  hash: string;
  mime: string;
  filename?: string;
}

export interface HydrationOptions {
  tokenBudget?: number;
  minTurns?: number;
  includeAttachmentReferences?: boolean;
}

interface TurnExcerpt {
  lines: string[];
  estimatedTokens: number;
  attachments: HydrationAttachmentReference[];
}

function outputText(outputJson: string | undefined): string | undefined {
  if (!outputJson) return undefined;
  try {
    const value = JSON.parse(outputJson) as unknown;
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const text = (value as { text?: unknown }).text;
      if (typeof text === "string") return text;
    }
  } catch {
    return outputJson;
  }
  return undefined;
}

export function hydrationMessagesFromLedger(
  turns: readonly Turn[],
  itemsForTurn: (turnId: string) => readonly Item[],
  attachmentsForItem: (itemId: string) => readonly Attachment[] = () => [],
  afterSeq = -1
): HydrationMessage[] {
  const messages: HydrationMessage[] = [];
  for (const turn of turns) {
    if (turn.seq <= afterSeq || turn.endedAt === undefined) continue;
    let assistantRecorded = false;
    for (const item of itemsForTurn(turn.turnId)) {
      if (item.kind === "message_in" && item.role === "user") {
        messages.push({
          payload: {
            kind: "user",
            text: item.text ?? "",
            attachments: attachmentsForItem(item.itemId).map((attachment) => ({
              hash: attachment.hash,
              mime: attachment.mime,
              ...(attachment.filename ? { filename: attachment.filename } : {}),
            })),
          },
          createdAt: item.startedAt,
        });
        continue;
      }
      if (item.kind === "tool") {
        messages.push({
          payload: {
            kind: "tool",
            tool: item.name ?? "tool",
            ok: item.ok,
            ...(item.argsJson ? { sql: item.argsJson } : {}),
            artifacts: attachmentsForItem(item.itemId).map((attachment) => ({
              hash: attachment.hash,
              ...(attachment.filename ? { filename: attachment.filename } : {}),
              ...(attachment.workspacePath
                ? { workspacePath: attachment.workspacePath }
                : {}),
            })),
          },
          createdAt: item.startedAt,
        });
        continue;
      }
      if (item.kind === "step" || item.kind === "delegate") {
        if (item.kind === "step" && item.name?.startsWith("notice:")) continue;
        const text = outputText(item.outputJson);
        if (!text) continue;
        messages.push({
          payload: { kind: "ai", text },
          createdAt: item.startedAt,
        });
        assistantRecorded = true;
      }
    }
    if (!assistantRecorded && turn.summary) {
      messages.push({
        payload: { kind: "ai", text: turn.summary },
        createdAt: turn.endedAt,
      });
    }
  }
  return messages;
}

const estimateTokens = (text: string): number =>
  Math.max(1, Math.ceil(text.length / 4));

const MANDATORY_TURN_MIN_TOKENS = 200;

function truncateTurn(turn: TurnExcerpt, maxTokens: number): TurnExcerpt {
  if (turn.estimatedTokens <= maxTokens) return turn;
  const marker = "\n[turn truncated to hydration budget]";
  const maxChars = Math.max(0, maxTokens * 4 - marker.length);
  const text = `${turn.lines.join("\n").slice(0, maxChars)}${marker}`;
  return {
    lines: text.split("\n"),
    estimatedTokens: estimateTokens(text),
    attachments: turn.attachments,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function compileTurns(
  messages: readonly HydrationMessage[],
  includeAttachmentReferences: boolean
): TurnExcerpt[] {
  const turns: TurnExcerpt[] = [];
  let lines: string[] = [];
  let attachments: HydrationAttachmentReference[] = [];
  const flush = (): void => {
    if (lines.length === 0) return;
    const text = lines.join("\n");
    turns.push({ lines, estimatedTokens: estimateTokens(text), attachments });
    lines = [];
    attachments = [];
  };

  for (const message of messages) {
    const payload = asRecord(message.payload);
    if (!payload || typeof payload.kind !== "string") continue;
    if (payload.kind === "user") {
      flush();
      lines.push(
        `User: ${typeof payload.text === "string" ? payload.text : ""}`
      );
      if (includeAttachmentReferences && Array.isArray(payload.attachments)) {
        const names = payload.attachments.flatMap((attachment) => {
          const record = asRecord(attachment);
          if (!record) return [];
          if (
            typeof record.hash === "string" &&
            typeof record.mime === "string"
          ) {
            attachments.push({
              hash: record.hash,
              mime: record.mime,
              ...(typeof record.filename === "string"
                ? { filename: record.filename }
                : {}),
            });
          }
          if (
            typeof record.filename === "string" &&
            typeof record.mime === "string"
          ) {
            return [`${record.filename} (${record.mime})`];
          }
          if (typeof record.filename === "string") return [record.filename];
          if (typeof record.mime === "string")
            return [`attachment (${record.mime})`];
          return ["attachment"];
        });
        if (names.length > 0) lines.push(`Attachments: ${names.join(", ")}`);
      }
      continue;
    }
    if (payload.kind === "tool") {
      const tool = typeof payload.tool === "string" ? payload.tool : "tool";
      const sql =
        typeof payload.sql === "string"
          ? ` — ${payload.sql.replace(/\s+/gu, " ").trim().slice(0, 240)}`
          : "";
      const status =
        payload.ok === true || payload.state === "ok"
          ? "ok"
          : payload.ok === false || payload.state === "error"
            ? "failed"
            : "unknown";
      lines.push(`Tool call: ${tool}${sql} → ${status}`);
      if (Array.isArray(payload.artifacts)) {
        const references = payload.artifacts.flatMap((artifact) => {
          const record = asRecord(artifact);
          if (!record) return [];
          const label =
            typeof record.workspacePath === "string"
              ? record.workspacePath
              : typeof record.filename === "string"
                ? record.filename
                : undefined;
          if (!label) return [];
          const hash =
            typeof record.hash === "string" && record.hash.length > 0
              ? ` (sha256 ${record.hash.slice(0, 12)}…)`
              : "";
          return [`${label}${hash}`];
        });
        if (references.length > 0) {
          lines.push(`Harness touched or produced: ${references.join(", ")}`);
        }
      }
      continue;
    }
    if (payload.kind === "ai") {
      lines.push(
        `Assistant: ${typeof payload.text === "string" ? payload.text : ""}`
      );
      flush();
    }
  }
  flush();
  return turns;
}

export function compileHydrationPlan(
  messages: readonly HydrationMessage[],
  options: HydrationOptions = {}
): HydrationPlan {
  const tokenBudget = Math.max(256, options.tokenBudget ?? 8_000);
  const minTurns = Math.max(1, options.minTurns ?? 2);
  const turns = compileTurns(
    messages,
    options.includeAttachmentReferences ?? false
  );
  const omittedPrefix = Math.max(
    0,
    turns.length - Math.min(minTurns, turns.length)
  );
  const headerFor = (omittedTurns: number): string =>
    [
      "[Centraid session handoff]",
      "The canonical ledger below is another harness's trusted conversation context. Continue from it without impersonating or repeating that harness.",
      omittedTurns > 0
        ? `${omittedTurns} older turn(s) omitted to fit the context budget.`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  const headerTokens = estimateTokens(headerFor(omittedPrefix));
  const bodyBudget = Math.max(1, tokenBudget - headerTokens - 2);
  const mandatoryFloor = Math.max(
    1,
    Math.min(MANDATORY_TURN_MIN_TOKENS, Math.floor(bodyBudget / minTurns))
  );
  const selected: TurnExcerpt[] = [];
  let estimatedTokens = 0;

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    if (
      selected.length >= minTurns &&
      estimatedTokens + turn.estimatedTokens > bodyBudget
    )
      break;
    const mandatoryRemaining = Math.max(0, minTurns - selected.length - 1);
    const remaining = Math.max(1, bodyBudget - estimatedTokens);
    const allocation =
      selected.length < minTurns
        ? Math.max(
            mandatoryFloor,
            remaining - mandatoryRemaining * mandatoryFloor
          )
        : Math.min(remaining, turn.estimatedTokens);
    const fitted = truncateTurn(turn, allocation);
    selected.push(fitted);
    estimatedTokens += fitted.estimatedTokens;
    if (estimatedTokens >= bodyBudget) break;
  }
  selected.reverse();
  const omittedTurns = Math.max(0, turns.length - selected.length);
  const body = selected
    .map((turn, index) =>
      [`Turn ${omittedTurns + index + 1}:`, ...turn.lines].join("\n")
    )
    .join("\n\n");
  const header = headerFor(omittedTurns);
  const prompt = body ? `${header}\n\n${body}\n[End session handoff]` : header;
  const finalMarker = "\n[End session handoff]";
  const boundedPrompt =
    estimateTokens(prompt) <= tokenBudget
      ? prompt
      : `${prompt.slice(0, Math.max(0, tokenBudget * 4 - finalMarker.length))}${finalMarker}`;
  const attachments = Array.from(
    new Map(
      selected
        .flatMap((turn) => turn.attachments)
        .map((attachment) => [attachment.hash, attachment] as const)
    ).values()
  );
  return {
    prompt: boundedPrompt,
    includedTurns: selected.length,
    omittedTurns,
    estimatedTokens: estimateTokens(boundedPrompt),
    attachments,
  };
}
