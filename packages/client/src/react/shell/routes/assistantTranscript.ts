import type { AsstMsgDTO, AsstUsageDTO } from "../../screen-contracts.js";
import { richAnswerHtml } from "./assistantRich.js";

export interface AsstToolCall {
  id: string;
  tool: string;
  sql?: string;
  state: "run" | "ok" | "error";
  totalRows?: number;
  durationMs?: number;
  errorText?: string;
  outputText?: string;
  artifacts?: Array<{ label: string; hash?: string; workspacePath?: string }>;
}

export function toolOutputText(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return typeof result === "string" && result.trim() ? result : undefined;
  }
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string")
      return [record.text];
    if (record.type === "terminal") {
      if (typeof record.output === "string") return [record.output];
      if (typeof record.text === "string") return [record.text];
    }
    return [];
  });
  return parts.length ? parts.join("\n") : undefined;
}
export interface AsstAttachment {
  hash: string;
  mime: string;
  filename?: string;
  sizeBytes: number;
}
export interface Attempt {
  turnId: string;
  text: string;
  error?: boolean;
  feedback: "up" | "down" | null;
  usage?: AsstUsageDTO;
}
export type AsstMsg =
  | {
      kind: "user";
      text: string;
      attachments?: AsstAttachment[];
      createdAt?: number;
    }
  | { kind: "thinking"; text: string; streaming?: boolean }
  | { kind: "notice"; level: "warn" | "info"; text: string }
  | {
      kind: "ai";
      text: string;
      error?: boolean;
      streaming?: boolean;
      catchingUp?: boolean;
      createdAt?: number;
      turnId?: string;
      feedback?: "up" | "down" | null;
      usage?: AsstUsageDTO;
      attempts?: Attempt[];
      activeAttempt?: number;
      failedText?: string;
      retryOf?: string;
      idempotencyKey?: string;
      offline?: boolean;
      fromArchive?: boolean;
    }
  | { kind: "tools"; calls: AsstToolCall[] };

export interface PendingAttachment {
  localId: string;
  filename: string;
  sizeBytes: number;
  mime: string;
  state: "uploading" | "ready" | "error";
  errorText?: string;
  ref?: AsstAttachment;
  previewUrl?: string;
}

export function activeAttemptOf(
  msg: Extract<AsstMsg, { kind: "ai" }>
): Attempt | null {
  const attempts = msg.attempts;
  if (!attempts?.length) return null;
  const i = Math.min(
    Math.max(msg.activeAttempt ?? attempts.length - 1, 0),
    attempts.length - 1
  );
  return attempts[i] ?? null;
}

export function hydrateMessages(
  rows: Array<{
    payload: CentraidConversationHistoryMessage;
    createdAt: number;
  }>,
  opts: { hasArchivedHistory?: boolean; archiveUnavailable?: boolean } = {}
): AsstMsg[] {
  const out: AsstMsg[] = [];
  if (opts.archiveUnavailable) {
    out.push({
      kind: "notice",
      level: "warn",
      text: "Some older messages couldn't be loaded from the archive right now.",
    });
  } else if (opts.hasArchivedHistory) {
    out.push({
      kind: "notice",
      level: "info",
      text: "Older messages below are restored from the archive (read-only).",
    });
  }
  for (const { payload, createdAt } of rows) {
    if (payload.kind === "user") {
      out.push({
        kind: "user",
        text: payload.text ?? "",
        createdAt,
        ...(payload.attachments?.length
          ? {
              attachments: payload.attachments.map((a) => ({
                hash: a.hash,
                mime: a.mime,
                ...(a.filename ? { filename: a.filename } : {}),
                sizeBytes: a.sizeBytes,
              })),
            }
          : {}),
      });
    } else if (payload.kind === "ai") {
      const msg: Extract<AsstMsg, { kind: "ai" }> = {
        kind: "ai",
        text: payload.text ?? "",
        createdAt,
        ...(payload.error ? { error: true } : {}),
        ...(payload.turnId ? { turnId: payload.turnId } : {}),
        ...(payload.feedback ? { feedback: payload.feedback } : {}),
        ...(payload.usage ? { usage: payload.usage } : {}),
        ...(payload.fromArchive ? { fromArchive: true } : {}),
      };
      if (payload.retry?.attempts?.length) {
        msg.attempts = payload.retry.attempts.map((a) => ({
          turnId: a.turnId,
          text: a.text,
          ...(a.error ? { error: true } : {}),
          feedback: a.feedback ?? null,
          ...(a.usage ? { usage: a.usage } : {}),
        }));
        msg.activeAttempt = msg.attempts.length - 1;
      }
      out.push(msg);
    } else if (payload.kind === "notice") {
      out.push({
        kind: "notice",
        level: payload.level,
        text: payload.text,
      });
    } else if (payload.kind === "tool") {
      const call: AsstToolCall = {
        id: payload.id ?? String(out.length),
        tool: payload.tool ?? "vault_sql",
        ...(payload.sql ? { sql: payload.sql } : {}),
        state: payload.state === "ok" ? "ok" : "error",
        ...(payload.state !== "ok" && payload.errorText
          ? { errorText: payload.errorText }
          : {}),
        ...(payload.result && toolOutputText(payload.result)
          ? { outputText: toolOutputText(payload.result)! }
          : {}),
        ...(payload.artifacts?.length
          ? {
              artifacts: payload.artifacts.map((artifact) => ({
                label:
                  artifact.filename ??
                  artifact.workspacePath ??
                  "Harness artifact",
                ...(artifact.hash ? { hash: artifact.hash } : {}),
                ...(artifact.workspacePath
                  ? { workspacePath: artifact.workspacePath }
                  : {}),
              })),
            }
          : {}),
      };
      const result = payload.result as
        | { totalRows?: number; durationMs?: number }
        | undefined;
      if (result && typeof result.totalRows === "number")
        call.totalRows = result.totalRows;
      if (result && typeof result.durationMs === "number")
        call.durationMs = result.durationMs;
      const last = out.at(-1);
      if (last?.kind === "tools") last.calls.push(call);
      else out.push({ kind: "tools", calls: [call] });
    }
  }
  return out;
}

export function msgToDTO(msg: AsstMsg, isLastAnswer: boolean): AsstMsgDTO {
  if (msg.kind === "user") {
    return {
      kind: "user",
      text: msg.text,
      ...(msg.createdAt ? { createdAt: msg.createdAt } : {}),
      ...(msg.attachments?.length
        ? {
            attachments: msg.attachments.map((a) => ({
              hash: a.hash,
              filename: a.filename ?? "Attachment",
              mime: a.mime,
              sizeBytes: a.sizeBytes,
            })),
          }
        : {}),
    };
  }
  if (msg.kind === "tools") {
    const n = msg.calls.length;
    const running = msg.calls.some((c) => c.state === "run");
    const failed = msg.calls.filter((c) => c.state === "error").length;
    const ms = msg.calls.reduce((a, c) => a + (c.durationMs ?? 0), 0);
    const label = running
      ? "querying the vault…"
      : `${n} ${n === 1 ? "query" : "queries"}${ms ? ` · ${ms}ms` : ""}${failed ? ` · ${failed} failed` : ""}`;
    return {
      kind: "tools",
      label,
      calls: msg.calls.map((c) => ({
        tool: c.tool,
        ...(c.sql ? { sql: c.sql } : {}),
        state: c.state,
        meta:
          c.state === "error"
            ? (c.errorText ?? "failed")
            : c.state === "ok"
              ? `${c.totalRows ?? "?"} rows${c.durationMs ? ` · ${c.durationMs}ms` : ""}${
                  c.artifacts?.length
                    ? ` · ${c.artifacts.length} artifact${c.artifacts.length === 1 ? "" : "s"}`
                    : ""
                }`
              : "running…",
        ...(c.outputText ? { outputText: c.outputText } : {}),
        ...(c.artifacts?.length ? { artifacts: c.artifacts } : {}),
      })),
    };
  }
  if (msg.kind === "thinking")
    return { kind: "thinking", text: msg.text, streaming: !!msg.streaming };
  if (msg.kind === "notice")
    return { kind: "notice", level: msg.level, text: msg.text };
  if (msg.streaming)
    return {
      kind: "ai",
      streaming: true,
      text: msg.text,
      ...(msg.catchingUp ? { catchingUp: true } : {}),
    };
  const active = activeAttemptOf(msg);
  const text = active ? active.text : msg.text;
  const error = active ? Boolean(active.error) : Boolean(msg.error);
  const turnId = msg.fromArchive
    ? undefined
    : active
      ? active.turnId
      : msg.turnId;
  const feedback = active ? active.feedback : (msg.feedback ?? null);
  const usage = active ? active.usage : msg.usage;
  return {
    kind: "ai",
    streaming: false,
    html: richAnswerHtml(text),
    error,
    copyText: text,
    ...(msg.createdAt ? { createdAt: msg.createdAt } : {}),
    ...(turnId ? { turnId } : {}),
    ...(usage ? { usage } : {}),
    feedback,
    ...(msg.attempts?.length
      ? {
          retry: {
            index: (msg.activeAttempt ?? msg.attempts.length - 1) + 1,
            count: msg.attempts.length,
          },
        }
      : {}),
    ...(isLastAnswer && !error && turnId ? { canRegenerate: true } : {}),
    ...(error && msg.failedText !== undefined ? { canRetry: true } : {}),
    ...(error && msg.offline ? { offline: true } : {}),
  };
}
