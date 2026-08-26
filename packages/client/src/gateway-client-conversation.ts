/*
 * governance: allow-repo-hygiene file-size-limit (#567) one browser-safe conversation transport owns the route DTOs and SSE parser together so wire additions cannot drift between request and stream handling
 *
 * Renderer-side chat transport over direct HTTP (#141), no desktop relay. SSE
 * uses fetch + a ReadableStream reader, never `EventSource`: a turn needs a
 * POST body and the Bearer header.
 */

import {
  appTurnPath,
  assistantTurnPath,
  assistantResolvePath,
} from "@centraid/core/protocol";

import type {
  CentraidHarnessesStatus,
  CentraidHarnessStatus,
} from "./centraid-api.js";
import { conversationStatusPath, blobsPath } from "./conversation-routes.js";
import {
  auth,
  authHeaders,
  doFetch,
  readJson,
  scopedAuthHeaders,
  GatewayClientError,
} from "./gateway-client-core.js";
import { consumeSse } from "./turn-stream.js";
import type { TurnStreamEvent } from "./turn-stream.js";

export { type TurnStreamEvent } from "./turn-stream.js";

export async function getHarnessStatus(
  opts: { refresh?: boolean } = {}
): Promise<CentraidHarnessStatus> {
  const { baseUrl, token } = await auth();
  const path = opts.refresh
    ? "/centraid/_turn/harness-status?refresh=1"
    : "/centraid/_turn/harness-status";
  const res = await doFetch(baseUrl, path, {
    method: "GET",
    headers: authHeaders(token),
  });
  return readJson<CentraidHarnessStatus>(res, "fetch harness status");
}

export async function getHarnessesStatus(
  opts: { refresh?: boolean } = {}
): Promise<CentraidHarnessesStatus> {
  const { baseUrl, token } = await auth();
  const path = opts.refresh
    ? "/centraid/_harnesses/status?refresh=1"
    : "/centraid/_harnesses/status";
  const res = await doFetch(baseUrl, path, {
    method: "GET",
    headers: authHeaders(token),
  });
  return readJson<CentraidHarnessesStatus>(res, "fetch agents status");
}

export interface ConversationAttachmentRef {
  hash: string;
  mime: string;
  sizeBytes: number;
  filename?: string;
}

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface StreamTurnInput {
  conversationId: string;
  message: string;
  /** Absent = builder chat; 'ask' takes the vault register (#286). */
  register?: "ask" | "build";
  /** Does not mutate the device default. */
  harnessKind?: string;
  model?: string;
  thinking?: string;
  attachments?: ConversationAttachmentRef[];
  /** Recorded as `turns.retry_of`, which collapses the pair into a pager. */
  retryOf?: string;
  /** A fresh UUID per user send, REUSED on every resend of that message, so a
   *  retry replays the recorded turn instead of double-running it (#420). */
  idempotencyKey?: string;
  /** Every provider approved so far must ride EACH resend (#567). */
  providerConsent?: string | string[];
  additionalDirectories?: string[];
  workspaceKind?: "vault-data" | "app" | "draft";
  /** A conversation is pinned to exactly ONE vault for its whole life (#599). */
  scopeId?: string;
}

export interface StreamTurnResult {
  /** True only when the terminal `event: end` arrived. */
  ended: boolean;
}

const TURN_BUSY_MAX_RETRIES = 4;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Auto-retries a `429` turn-busy; safe only because a stable `idempotencyKey`
// makes the retry a replay (#420).
async function postTurnWithRetry(
  path: string,
  body: string,
  signal: AbortSignal,
  errLabel: string,
  scopeId?: string
): Promise<Response> {
  const { baseUrl, token } = await auth();
  async function postAttempt(attempt: number): Promise<Response> {
    const res = await doFetch(baseUrl, path, {
      method: "POST",
      headers: scopedAuthHeaders(token, scopeId, "application/json"),
      body,
      signal,
    });
    if (res.status === 429 && attempt < TURN_BUSY_MAX_RETRIES) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 3000;
      await res.body?.cancel().catch(() => undefined);
      await delay(waitMs);
      return postAttempt(attempt + 1);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        throw new GatewayClientError(
          "auth_required",
          `${errLabel}: gateway rejected request (HTTP ${res.status}).`
        );
      }
      if (res.status === 429) {
        throw new GatewayClientError(
          "gateway_error",
          `${errLabel}: still busy after ${TURN_BUSY_MAX_RETRIES} retries — try again shortly.`
        );
      }
      throw new GatewayClientError(
        "gateway_error",
        `${errLabel} failed (HTTP ${res.status}): ${text || res.statusText}`
      );
    }
    if (!res.body)
      throw new GatewayClientError(
        "gateway_error",
        `${errLabel}: gateway returned no stream body.`
      );
    return res;
  }
  return postAttempt(0);
}

export async function uploadConversationAttachment(
  appId: string,
  bytes: Uint8Array,
  mime: string,
  filename?: string,
  scopeId?: string
): Promise<ConversationAttachmentRef> {
  const { baseUrl, token } = await auth();
  // The blob CAS is vault-partitioned, so the conversation's scope must ride
  // the upload or the turn resolves the hash in the wrong vault (#599).
  const res = await doFetch(baseUrl, blobsPath(appId), {
    method: "POST",
    headers: scopedAuthHeaders(token, scopeId, mime),
    body: bytes as BodyInit,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GatewayClientError(
      "gateway_error",
      `upload failed (HTTP ${res.status}): ${text}`
    );
  }
  const out = (await res.json()) as { hash: string; sizeBytes: number };
  return {
    hash: out.hash,
    mime,
    sizeBytes: out.sizeBytes,
    ...(filename ? { filename } : {}),
  };
}

export async function streamTurn(
  appId: string,
  input: StreamTurnInput,
  onEvent: (event: TurnStreamEvent) => void,
  signal: AbortSignal
): Promise<StreamTurnResult> {
  const res = await postTurnWithRetry(
    appTurnPath(appId),
    JSON.stringify({
      conversationId: input.conversationId,
      message: input.message,
      ...(input.register ? { register: input.register } : {}),
      ...(input.harnessKind ? { harnessKind: input.harnessKind } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.thinking ? { thinking: input.thinking } : {}),
      ...(input.retryOf ? { retryOf: input.retryOf } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(input.providerConsent?.length
        ? { providerConsent: input.providerConsent }
        : {}),
      ...(input.additionalDirectories === undefined
        ? {}
        : { additionalDirectories: input.additionalDirectories }),
      ...(input.workspaceKind ? { workspaceKind: input.workspaceKind } : {}),
    }),
    signal,
    "chat",
    input.scopeId
  );
  return consumeSse(res.body!, onEvent, { signal });
}

// ───────────────────────── vault assistant ─────────────────────

export const ASSISTANT_APP_ID = "_assistant";

export interface AssistantRefCard {
  type: string;
  id: string;
  status: "live" | "trashed" | "missing" | "denied" | "unknown";
  title: string | null;
  subtitle: string | null;
}

export async function streamAssistantTurn(
  input: StreamTurnInput,
  onEvent: (event: TurnStreamEvent) => void,
  signal: AbortSignal
): Promise<StreamTurnResult> {
  const res = await postTurnWithRetry(
    assistantTurnPath(),
    JSON.stringify({
      conversationId: input.conversationId,
      message: input.message,
      ...(input.harnessKind ? { harnessKind: input.harnessKind } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.thinking ? { thinking: input.thinking } : {}),
      ...(input.retryOf ? { retryOf: input.retryOf } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(input.providerConsent?.length
        ? { providerConsent: input.providerConsent }
        : {}),
      ...(input.additionalDirectories === undefined
        ? {}
        : { additionalDirectories: input.additionalDirectories }),
      ...(input.workspaceKind ? { workspaceKind: input.workspaceKind } : {}),
    }),
    signal,
    "assistant",
    input.scopeId
  );
  return consumeSse(res.body!, onEvent, { signal });
}

export async function conversationStatus(
  appId: string,
  sessionId: string,
  scopeId?: string
): Promise<{ turnCount: number; updatedAt: number }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, conversationStatusPath(appId, sessionId), {
    method: "GET",
    headers: scopedAuthHeaders(token, scopeId),
  });
  return readJson(res, "conversation status");
}

export async function resolveAssistantRefs(
  refs: Array<{ type: string; id: string }>
): Promise<AssistantRefCard[]> {
  if (refs.length === 0) return [];
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, assistantResolvePath(), {
    method: "POST",
    headers: authHeaders(token, "application/json"),
    body: JSON.stringify({ refs }),
  });
  const out = await readJson<{ cards: AssistantRefCard[] }>(
    res,
    "resolve assistant refs"
  );
  return out.cards ?? [];
}

export * from "./gateway-client-conversation-history.js";
