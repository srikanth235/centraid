/*
 * Translating ACP `session/update` notifications into the normalized
 * `TurnStreamEvent` shape every surface (chat + builder) consumes. Wire shape
 * (verified against the public ACP spec): `session/update`
 * { sessionId, update: { sessionUpdate, ... } } — variants
 * agent_message_chunk, agent_thought_chunk, tool_call, tool_call_update,
 * plan, user_message_chunk, available_commands_update, current_mode_update,
 * usage_update.
 *
 * The mapper owns the per-turn accumulation only it can see: the assistant
 * text assembled from chunks, which tool calls are open, and the usage folded
 * off `usage_update`. The orchestrator reads those back at the end of the turn.
 */

import type { SessionNotification, Usage } from "@agentclientprotocol/sdk";

import type { TurnStreamEvent } from "@centraid/server/engine";

import { firstString, textOf } from "./content.js";
import { readCost, readTokenUsage } from "./usage.js";
import type { TokenUsage, UsageCost } from "./usage.js";

export interface SessionUpdateMapper {
  /** Feed one `session/update` notification's `params`. */
  handleSessionUpdate: (params: SessionNotification) => void;
  // Is the harness itself already streaming a tool call by this name? A
  // harness that surfaces its MCP calls announces `tool_call` before dialing
  // our endpoint, so a matching open ACP tool call means our own events would
  // double-render it; private-MCP harnesses leave nothing open, so we emit.
  // The `includes` is deliberate: namespacing harnesses surface the tool as
  // `mcp__centraid__vault_sql`.
  harnessStreamsTool: (toolName: string) => boolean;
  /** Assistant text accumulated across `agent_message_chunk`s. */
  finalText: () => string;
  /** Merge a token breakdown read elsewhere (the `session/prompt` result). */
  foldTokenUsage: (source: Usage) => void;
  /** Everything folded so far, for the single end-of-turn `usage` event. */
  usage: () => {
    tokens: TokenUsage;
    cost: UsageCost | undefined;
    context: { used?: number; size?: number } | undefined;
  };
}

type ToolDiff = { path?: string; oldText?: string; newText?: string };
type PlanEntry = { content: string; status?: string; priority?: string };
type ToolLocation = { path: string; line?: number };
type InlineArtifact = { dataBase64: string; mime: string; filename?: string };

function normalizeLocations(value: unknown): ToolLocation[] {
  if (!Array.isArray(value)) return [];
  const out: ToolLocation[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    if (typeof rec.path !== "string" || rec.path.length === 0) continue;
    out.push({
      path: rec.path,
      ...(typeof rec.line === "number" && Number.isFinite(rec.line)
        ? { line: rec.line }
        : {}),
    });
  }
  return out;
}

/** ACP blocks with bytes but no workspace location become CAS artifacts. */
function extractInlineArtifacts(value: unknown): InlineArtifact[] {
  const content = Array.isArray(value)
    ? value
    : value &&
        typeof value === "object" &&
        Array.isArray((value as { content?: unknown }).content)
      ? (value as { content: unknown[] }).content
      : [];
  const out: InlineArtifact[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const rec = block as Record<string, unknown>;
    if (rec.type === "content") {
      const text = textOf(rec.content);
      if (text) {
        out.push({
          dataBase64: Buffer.from(text).toString("base64"),
          mime: "text/plain",
          filename: "tool-output.txt",
        });
      }
      continue;
    }
    if (rec.type === "terminal") {
      const text = firstString(rec.output, rec.text);
      if (text) {
        out.push({
          dataBase64: Buffer.from(text).toString("base64"),
          mime: "text/plain",
          filename: "terminal-output.txt",
        });
      }
      continue;
    }
    if (
      (rec.type === "image" || rec.type === "audio") &&
      typeof rec.data === "string" &&
      rec.data.length > 0
    ) {
      out.push({
        dataBase64: rec.data,
        mime:
          typeof rec.mimeType === "string"
            ? rec.mimeType
            : "application/octet-stream",
      });
      continue;
    }
    if (
      rec.type !== "resource" ||
      !rec.resource ||
      typeof rec.resource !== "object"
    )
      continue;
    const resource = rec.resource as Record<string, unknown>;
    const blob =
      typeof resource.blob === "string"
        ? resource.blob
        : typeof resource.text === "string"
          ? Buffer.from(resource.text).toString("base64")
          : undefined;
    if (!blob) continue;
    const uri = typeof resource.uri === "string" ? resource.uri : undefined;
    out.push({
      dataBase64: blob,
      mime:
        typeof resource.mimeType === "string"
          ? resource.mimeType
          : "application/octet-stream",
      ...(uri ? { filename: uri.split("/").at(-1) || "artifact" } : {}),
    });
  }
  return out;
}

function renderableToolContent(value: unknown): unknown[] {
  const content = Array.isArray(value)
    ? value
    : value &&
        typeof value === "object" &&
        Array.isArray((value as { content?: unknown }).content)
      ? (value as { content: unknown[] }).content
      : [];
  return content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const rec = block as Record<string, unknown>;
    if (rec.type === "content") return [rec.content];
    if (rec.type === "terminal") {
      return [
        {
          type: "terminal",
          ...(typeof rec.terminalId === "string"
            ? { terminalId: rec.terminalId }
            : {}),
          ...(typeof rec.output === "string" ? { output: rec.output } : {}),
          ...(typeof rec.text === "string" ? { text: rec.text } : {}),
        },
      ];
    }
    return [];
  });
}

/** Pull `type: "diff"` content blocks out of ACP tool content arrays. */
export function extractToolDiffs(content: unknown): ToolDiff[] {
  if (!Array.isArray(content)) {
    // Some agents put a single block or nest under { content: [...] }.
    if (
      content &&
      typeof content === "object" &&
      Array.isArray((content as { content?: unknown }).content)
    ) {
      return extractToolDiffs((content as { content: unknown }).content);
    }
    return [];
  }
  const out: ToolDiff[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const rec = block as Record<string, unknown>;
    if (rec.type !== "diff") continue;
    const path =
      typeof rec.path === "string"
        ? rec.path
        : typeof rec.filePath === "string"
          ? rec.filePath
          : undefined;
    out.push({
      ...(path ? { path } : {}),
      ...(typeof rec.oldText === "string" ? { oldText: rec.oldText } : {}),
      ...(typeof rec.newText === "string" ? { newText: rec.newText } : {}),
    });
  }
  return out;
}

/** Normalize plan entries from ACP `sessionUpdate: "plan"`. */
export function normalizePlanEntries(entries: unknown): PlanEntry[] {
  if (!Array.isArray(entries)) return [];
  const out: PlanEntry[] = [];
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const rec = e as Record<string, unknown>;
    const content =
      typeof rec.content === "string"
        ? rec.content
        : typeof rec.text === "string"
          ? rec.text
          : typeof rec.title === "string"
            ? rec.title
            : undefined;
    if (!content) continue;
    out.push({
      content,
      ...(typeof rec.status === "string" ? { status: rec.status } : {}),
      ...(typeof rec.priority === "string" ? { priority: rec.priority } : {}),
    });
  }
  return out;
}

export function createSessionUpdateMapper(
  emit: (event: TurnStreamEvent) => void
): SessionUpdateMapper {
  let sentAssistantStart = false;
  let finalText = "";
  const toolTitles = new Map<string, string>();
  const toolDone = new Set<string>();
  let usageTokens: TokenUsage = {};
  let usageCost: UsageCost | undefined;
  let contextUsage: { used?: number; size?: number } | undefined;

  const ensureStarted = (): void => {
    if (sentAssistantStart) return;
    sentAssistantStart = true;
    emit({ type: "assistant.start" });
  };

  const harnessStreamsTool = (toolName: string): boolean => {
    const needle = toolName.toLowerCase();
    if (!needle) return false;
    for (const [id, title] of toolTitles) {
      if (toolDone.has(id)) continue;
      if (title.toLowerCase().includes(needle)) return true;
    }
    return false;
  };

  const maybeEmitToolResult = (
    id: string,
    update: Record<string, unknown>
  ): void => {
    const status =
      typeof update.status === "string" ? update.status : undefined;
    if (status !== "completed" && status !== "failed") return;
    if (toolDone.has(id)) return;
    toolDone.add(id);
    const ok = status === "completed";
    const renderableContent = renderableToolContent(update.content);
    const result =
      update.rawOutput &&
      typeof update.rawOutput === "object" &&
      !Array.isArray(update.rawOutput)
        ? {
            ...(update.rawOutput as Record<string, unknown>),
            ...(renderableContent.length
              ? {
                  content: renderableContent,
                  // The harness's own `rawOutput.content` is its payload, not
                  // our renderable projection — overwriting the key would
                  // silently drop tool output the harness chose to return.
                  ...((update.rawOutput as Record<string, unknown>).content ===
                  undefined
                    ? {}
                    : {
                        rawOutputContent: (
                          update.rawOutput as Record<string, unknown>
                        ).content,
                      }),
                }
              : {}),
          }
        : renderableContent.length
          ? { rawOutput: update.rawOutput ?? null, content: renderableContent }
          : (update.rawOutput ?? update.content ?? null);
    const errorText = ok
      ? undefined
      : textOf(update.content) || "tool call failed";
    let diffs = extractToolDiffs(update.content);
    if (diffs.length === 0 && update.rawOutput !== undefined) {
      diffs = extractToolDiffs(update.rawOutput);
    }
    const locations = normalizeLocations(update.locations);
    const artifacts = extractInlineArtifacts(update.content);
    const hasTerminal = Array.isArray(update.content)
      ? update.content.some(
          (block) =>
            !!block &&
            typeof block === "object" &&
            (block as Record<string, unknown>).type === "terminal"
        )
      : false;
    if (
      hasTerminal &&
      !artifacts.some(
        (artifact) => artifact.filename === "terminal-output.txt"
      ) &&
      update.rawOutput !== undefined
    ) {
      const raw =
        typeof update.rawOutput === "string"
          ? update.rawOutput
          : JSON.stringify(update.rawOutput, null, 2);
      if (raw) {
        artifacts.push({
          dataBase64: Buffer.from(raw).toString("base64"),
          mime:
            typeof update.rawOutput === "string"
              ? "text/plain"
              : "application/json",
          filename:
            typeof update.rawOutput === "string"
              ? "terminal-output.txt"
              : "terminal-output.json",
        });
      }
    }
    emit({
      type: "tool.result",
      toolCallId: id,
      toolName: toolTitles.get(id) ?? "tool",
      ok,
      result,
      rawJson: JSON.stringify(update),
      ...(errorText ? { errorText } : {}),
      ...(diffs.length ? { diffs } : {}),
      ...(locations.length ? { locations } : {}),
      ...(artifacts.length ? { artifacts } : {}),
    });
    // Builder-friendly parallel signal: each file change as a phase so UIs
    // that only listen for `phase` still see diffs.
    for (const d of diffs) {
      emit({ type: "phase", phase: "diff", detail: d });
    }
  };

  const handleSessionUpdate = (params: SessionNotification): void => {
    const update = params.update;
    const kind = update.sessionUpdate;

    if (kind === "agent_message_chunk") {
      const text = textOf(update.content);
      if (text) {
        ensureStarted();
        finalText += text;
        emit({ type: "assistant.delta", delta: text });
      }
      return;
    }
    if (kind === "agent_thought_chunk") {
      const text = textOf(update.content);
      if (text) {
        ensureStarted();
        emit({ type: "reasoning.delta", delta: text });
      }
      return;
    }
    if (kind === "tool_call") {
      const id = String(update.toolCallId ?? "");
      if (!id) return;
      const title = firstString(update.title, update.kind) ?? "tool";
      toolTitles.set(id, title);
      ensureStarted();
      emit({
        type: "tool.start",
        toolCallId: id,
        toolName: title,
        rawJson: JSON.stringify(update),
        ...(update.rawInput === undefined ? {} : { args: update.rawInput }),
        ...(typeof update.kind === "string" ? { kind: update.kind } : {}),
      });
      maybeEmitToolResult(id, update);
      return;
    }
    if (kind === "tool_call_update") {
      const id = String(update.toolCallId ?? "");
      if (!id) return;
      maybeEmitToolResult(id, update);
      return;
    }
    if (kind === "plan") {
      const plan = normalizePlanEntries(update.entries);
      emit({
        type: "phase",
        phase: "plan",
        ...(update.entries === undefined ? {} : { detail: update.entries }),
        ...(plan.length ? { plan } : {}),
      });
      return;
    }
    if (kind === "usage_update") {
      // Per the SDK schema, `usage_update` carries context-window used/size
      // plus cumulative cost; token totals come from `PromptResponse.usage`.
      const cost = readCost(update.cost);
      if (cost) usageCost = cost;
      const used =
        typeof update.used === "number" &&
        Number.isFinite(update.used) &&
        update.used >= 0
          ? update.used
          : undefined;
      const size =
        typeof update.size === "number" &&
        Number.isFinite(update.size) &&
        update.size > 0
          ? update.size
          : undefined;
      if (used !== undefined || size !== undefined) {
        // ACP sessions may self-compact, so `used` is deliberately a latest
        // snapshot rather than a monotonic max.
        contextUsage = {
          ...(used === undefined ? {} : { used }),
          ...(size === undefined ? {} : { size }),
        };
        emit({ type: "context", ...contextUsage });
      }
    }
    // user_message_chunk / available_commands_update / current_mode_update /
    // config_option_update: product owns slash commands; config updates are
    // consumed by the backend's pin state.
  };

  return {
    handleSessionUpdate,
    harnessStreamsTool,
    finalText: () => finalText,
    foldTokenUsage: (source) => {
      usageTokens = { ...usageTokens, ...readTokenUsage(source) };
    },
    usage: () => ({
      tokens: usageTokens,
      cost: usageCost,
      context: contextUsage,
    }),
  };
}
