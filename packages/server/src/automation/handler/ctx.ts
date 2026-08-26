/** Parent-side handlers for the worker's `ctx.*` messages (#80); replies in the worker's shape. */

import type {
  ConversationStore,
  TurnStreamEvent,
  VaultBridge,
  VaultOp,
} from "@centraid/server/engine";

import {
  closeRunNode,
  openRunNode,
  rowToRunRef,
  usageCloseFields,
} from "./audit.js";
import type { RunEventSink } from "./audit.js";
import type {
  DelegateAttachment,
  DelegateDispatcher,
  DispatchContext,
} from "./runner.js";

export interface AuditState {
  store: ConversationStore;
  runId: string;
  automationId: string;
  ordinal: number;
  /** Live run-stream sink; no-op until the host wires a bus (#158). */
  emit: RunEventSink;
}

export function nextOrdinal(audit: AuditState): number {
  return audit.ordinal++;
}

export interface CtxReply {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** One `ctx.delegate` content reference, as sent by the worker (#299). */
export interface DelegateContentRef {
  contentId: string;
  variant: string;
  maxBytes?: number;
}

/**
 * Resolve `ctx.delegate` content refs into attachments via the vault
 * bridge (#299), under the automation's grant. Fail-closed: denial fails
 * the call — never a silent partial prompt.
 */
export async function resolveContentAttachments(
  vault: VaultBridge | undefined,
  refs: readonly DelegateContentRef[]
): Promise<DelegateAttachment[]> {
  // Content-free calls need no vault authority (probes pass []).
  if (refs.length === 0) return [];
  if (!vault) {
    throw new Error(
      "ctx.delegate content refs need a vault surface — the host mounted no vault plane"
    );
  }
  return Promise.all(
    refs.map(async (ref, i) => {
      const reply = await vault({
        op: "content",
        payload: {
          contentId: ref.contentId,
          variant: ref.variant,
          ...(ref.maxBytes === undefined ? {} : { maxBytes: ref.maxBytes }),
        },
      });
      if (!reply.ok) {
        throw new Error(
          `ctx content[${i}] (${ref.contentId} ${ref.variant}): ${reply.error}`
        );
      }
      const out = reply.result as
        | { status: "ok"; kind: "bytes"; mediaType: string; base64: string }
        | { status: "ok"; kind: "text"; mediaType: string; text: string }
        | { status: string };
      if (out.status !== "ok") {
        throw new Error(
          `ctx content[${i}] (${ref.contentId} ${ref.variant}) did not resolve: ${out.status}`
        );
      }
      const resolved = out as {
        kind: "bytes" | "text";
        mediaType: string;
        base64?: string;
        text?: string;
      };
      const ext =
        resolved.kind === "text"
          ? "txt"
          : (resolved.mediaType.split("/")[1] ?? "bin");
      return {
        name: `content-${i}-${ref.contentId.slice(0, 8)}.${ext}`,
        mediaType: resolved.mediaType,
        ...(resolved.base64 === undefined ? {} : { base64: resolved.base64 }),
        ...(resolved.text === undefined ? {} : { text: resolved.text }),
      };
    })
  );
}

/**
 * Service one `ctx.delegate` call: open a `delegate` node, dispatch, forward
 * events as `item.delta`, settle with the token/model rollup.
 */
export async function handleDelegateMessage(
  audit: AuditState,
  dispatchCtx: DispatchContext,
  delegateDispatcher: DelegateDispatcher,
  prompt: string,
  json: unknown,
  harness: string | undefined,
  model: string | undefined,
  configPins: Readonly<Record<string, string>> | undefined,
  content?: readonly DelegateContentRef[],
  vault?: VaultBridge
): Promise<CtxReply> {
  const ordinal = nextOrdinal(audit);
  const started = Date.now();

  const nodeId = openRunNode({
    store: audit.store,
    emit: audit.emit,
    runId: audit.runId,
    ordinal,
    kind: "delegate",
    name: "delegate",
    args: {
      prompt,
      ...(harness ? { harness } : {}),
      ...(model ? { model } : {}),
      ...(configPins ? { configPins } : {}),
      ...(content?.length ? { content } : {}),
    },
    started,
  });
  // Forward chat events as `item.delta` (#158); keep the last usage
  // for closeRunNode's rollup. ACP tool calls become durable items keyed by
  // toolCallId: parallel calls share names — ordinal/name correlation void.
  let lastUsage: Extract<TurnStreamEvent, { type: "usage" }> | undefined;
  let finalRawJson: string | undefined;
  const toolItems = new Map<
    string,
    { itemId: string; ordinal: number; started: number; name: string }
  >();
  const onEvent = (ev: TurnStreamEvent): void => {
    if (ev.type === "usage") lastUsage = ev;
    // Keep the last envelope WITH one: an error after a final must not blank it.
    if (
      (ev.type === "final" || ev.type === "error") &&
      ev.rawJson !== undefined
    ) {
      finalRawJson = ev.rawJson;
    }
    try {
      if (ev.type === "tool.start") {
        const toolOrdinal = nextOrdinal(audit);
        const toolStarted = Date.now();
        const itemId = openRunNode({
          store: audit.store,
          emit: audit.emit,
          runId: audit.runId,
          ordinal: toolOrdinal,
          callId: ev.toolCallId,
          kind: "tool",
          name: ev.toolName,
          ...(ev.args === undefined ? {} : { args: ev.args }),
          ...(ev.rawJson === undefined ? {} : { rawJson: ev.rawJson }),
          started: toolStarted,
        });
        toolItems.set(ev.toolCallId, {
          itemId,
          ordinal: toolOrdinal,
          started: toolStarted,
          name: ev.toolName,
        });
        audit.emit({
          type: "item.delta",
          itemId,
          ordinal: toolOrdinal,
          callId: ev.toolCallId,
          event: ev,
        });
        return;
      }
      if (ev.type === "tool.result") {
        const open = toolItems.get(ev.toolCallId);
        if (open) {
          audit.emit({
            type: "item.delta",
            itemId: open.itemId,
            ordinal: open.ordinal,
            callId: ev.toolCallId,
            event: ev,
          });
          closeRunNode({
            store: audit.store,
            emit: audit.emit,
            nodeId: open.itemId,
            ordinal: open.ordinal,
            callId: ev.toolCallId,
            ok: ev.ok,
            ...(ev.result === undefined ? {} : { result: ev.result }),
            ...(ev.errorText === undefined ? {} : { error: ev.errorText }),
            ...(ev.rawJson === undefined ? {} : { rawJson: ev.rawJson }),
            started: open.started,
            ended: Date.now(),
          });
          toolItems.delete(ev.toolCallId);
          return;
        }
      }
      audit.emit({ type: "item.delta", itemId: nodeId, ordinal, event: ev });
    } catch {
      /* swallow */
    }
  };
  const closeDanglingTools = (error: string): void => {
    for (const [callId, open] of toolItems) {
      closeRunNode({
        store: audit.store,
        emit: audit.emit,
        nodeId: open.itemId,
        ordinal: open.ordinal,
        callId,
        ok: false,
        error,
        started: open.started,
        ended: Date.now(),
      });
    }
    toolItems.clear();
  };
  try {
    const attachments = content?.length
      ? await resolveContentAttachments(vault, content)
      : undefined;
    const result = await delegateDispatcher(
      {
        prompt,
        json,
        ...(harness ? { harness } : {}),
        ...(model ? { model } : {}),
        ...(configPins ? { configPins } : {}),
        ...(attachments ? { attachments } : {}),
        onEvent,
      },
      dispatchCtx
    );
    closeDanglingTools("Tool call ended without a terminal result.");
    closeRunNode({
      store: audit.store,
      emit: audit.emit,
      nodeId,
      ordinal,
      ok: true,
      result,
      ...(finalRawJson === undefined ? {} : { rawJson: finalRawJson }),
      started,
      ended: Date.now(),
      ...usageCloseFields(lastUsage),
    });
    const confirmedResult =
      lastUsage?.model &&
      result &&
      typeof result === "object" &&
      !Array.isArray(result)
        ? {
            ...(result as Record<string, unknown>),
            __centraidModel: lastUsage.model,
          }
        : result;
    return { ok: true, result: confirmedResult };
  } catch (caughtError) {
    const error =
      caughtError instanceof Error ? caughtError.message : String(caughtError);
    closeDanglingTools(error);
    closeRunNode({
      store: audit.store,
      emit: audit.emit,
      nodeId,
      ordinal,
      ok: false,
      error,
      ...(finalRawJson === undefined ? {} : { rawJson: finalRawJson }),
      started,
      ended: Date.now(),
      ...usageCloseFields(lastUsage),
    });
    return { ok: false, error };
  }
}

/**
 * Service one `ctx.vault` call: open a `tool` node named `vault.<op>`, proxy
 * the host-injected bridge (the enrolled credential lives host-side), settle.
 * Replay safety: missing invocationId gets a deterministic one (run id +
 * ordinal) — re-firing replays, never double-executes. Without a bridge:
 * fail closed VAULT_UNAVAILABLE.
 */
export async function handleVaultMessage(
  audit: AuditState,
  vault: VaultBridge | undefined,
  op: VaultOp,
  payload: Record<string, unknown>
): Promise<CtxReply & { code?: string }> {
  const ordinal = nextOrdinal(audit);
  const started = Date.now();
  let effective = payload;
  if (op === "invoke" && typeof effective.invocationId !== "string") {
    effective = { ...effective, invocationId: `${audit.runId}:v${ordinal}` };
  }
  const nodeId = openRunNode({
    store: audit.store,
    emit: audit.emit,
    runId: audit.runId,
    ordinal,
    kind: "tool",
    name: `vault.${op}`,
    args: effective,
    started,
  });
  const settle = (
    reply: CtxReply & { code?: string }
  ): CtxReply & { code?: string } => {
    closeRunNode({
      store: audit.store,
      emit: audit.emit,
      nodeId,
      ordinal,
      ok: reply.ok,
      ...(reply.result === undefined ? {} : { result: reply.result }),
      ...(reply.error === undefined ? {} : { error: reply.error }),
      started,
      ended: Date.now(),
    });
    return reply;
  };
  if (!vault) {
    return settle({
      ok: false,
      code: "VAULT_UNAVAILABLE",
      error:
        "this automation has no vault surface — the host mounted no vault plane",
    });
  }
  try {
    const result = await vault({ op, payload: effective });
    if (!result.ok) {
      return settle({
        ok: false,
        ...(result.code ? { code: result.code } : {}),
        error: result.error ?? "vault call failed",
      });
    }
    return settle({ ok: true, result: result.result });
  } catch (error) {
    return settle({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function handleStateMessage(
  audit: AuditState,
  method: "get" | "set" | "delete",
  key: string,
  value: unknown
): CtxReply {
  try {
    if (method === "get") {
      const entry = audit.store.stateGet(audit.automationId, key);
      if (!entry) return { ok: true, result: undefined };
      try {
        return { ok: true, result: JSON.parse(entry.valueJson) as unknown };
      } catch {
        return { ok: true, result: entry.valueJson };
      }
    }
    if (method === "set") {
      const json = JSON.stringify(value === undefined ? null : value);
      audit.store.stateSet(audit.automationId, key, json, Date.now());
      return { ok: true };
    }
    if (method === "delete") {
      audit.store.stateDelete(audit.automationId, key);
      return { ok: true };
    }
    return { ok: false, error: `unknown state method: ${String(method)}` };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function handleRunsMessage(
  audit: AuditState,
  method: "last" | "list",
  filter: {
    automationId?: string;
    status?: "ok" | "error";
    since?: number;
    limit?: number;
  }
): CtxReply {
  try {
    // An automation's runs are its ref-keyed conversation's turns.
    const automationRef = filter.automationId ?? audit.automationId;
    const limit = filter.limit ?? 50;
    // One extra row drops the in-progress self-turn without shorting the limit.
    const rows = audit.store
      .listAutomationTurns(automationRef, {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.since === undefined ? {} : { since: filter.since }),
        limit: limit + 1,
      })
      .filter((r) => r.turnId !== audit.runId)
      .slice(0, limit);
    const toRef = (r: (typeof rows)[number]): ReturnType<typeof rowToRunRef> =>
      rowToRunRef(r, automationRef, audit.store.messageInText(r.turnId));
    if (method === "last") {
      const first = rows[0];
      return { ok: true, result: first ? toRef(first) : undefined };
    }
    return { ok: true, result: rows.map(toRef) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
