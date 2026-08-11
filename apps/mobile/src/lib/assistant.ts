import * as DocumentPicker from "expo-document-picker";
import { fetch as expoFetch } from "expo/fetch";

import { apiHeaders, fetchJson, requireGatewayBase } from "./gateway";

const APP_ID = "_assistant";
const sessionsPath = `/_centraid-conversations/apps/${APP_ID}/sessions`;

export interface AssistantHistoryBubble {
  key: string;
  role: "user" | "assistant";
  text: string;
  error?: boolean;
}

interface AgentConfigOption {
  category: string;
  currentValue?: string;
  values?: Array<{ value: string; name?: string }>;
}

interface AgentStatus {
  kind: string;
  label: string;
  available: boolean;
  hint?: string;
  models?: Array<{ id: string; name?: string; default?: boolean }>;
  capabilities?: {
    configOptions?: AgentConfigOption[];
    reachable?: boolean;
    authRequired?: boolean;
    reason?: string;
    modelConfigurable?: boolean;
    usageUpdateObserved?: boolean;
    promptImage?: boolean;
    promptAudio?: boolean;
    promptEmbeddedContext?: boolean;
  };
}

export interface AssistantAttachment {
  hash: string;
  mime: string;
  sizeBytes: number;
  filename: string;
}

export interface AssistantConfig {
  harnesses: Array<{
    kind: string;
    label: string;
    available: boolean;
    models: Array<{ id: string; name: string }>;
    selectedModel: string;
    efforts: Array<{ id: string; name: string }>;
    selectedEffort: string;
    supportsAttachments: boolean;
    supportsContext: boolean;
    sessionReady: boolean;
    hint?: string;
  }>;
  harnessKind: string;
  models: Array<{ id: string; name: string }>;
  selectedModel: string;
  efforts: Array<{ id: string; name: string }>;
  selectedEffort: string;
  supportsAttachments: boolean;
  supportsContext: boolean;
}

export type AssistantTurnEvent =
  | { type: "assistant.start" }
  | { type: "assistant.delta"; delta: string }
  | { type: "final"; text: string }
  | { type: "context"; used?: number; size?: number }
  | { type: "usage"; model?: string; effort?: string }
  | { type: "error"; message: string }
  | { type: "consent.required"; provider: string; message: string };

function prefString(prefs: Record<string, unknown>, key: string): string {
  const value = prefs[key];
  return typeof value === "string" ? value : "";
}

export async function loadAssistantConfig(
  options: { refresh?: boolean } = {}
): Promise<AssistantConfig> {
  const base = await requireGatewayBase();
  const [status, prefResult] = await Promise.all([
    fetchJson<{ agents?: AgentStatus[] }>(
      `${base}/centraid/_agents/status${options.refresh ? "?refresh=1" : ""}`,
      {
        headers: apiHeaders(),
      }
    ),
    fetchJson<{ prefs?: Record<string, unknown> }>(
      `${base}/_centraid-user/prefs`,
      {
        headers: apiHeaders(),
      }
    ),
  ]);
  const prefs = prefResult.prefs ?? {};
  const harnessKind =
    prefString(prefs, "harness.assistant") ||
    prefString(prefs, "agent.harness.kind") ||
    "codex";
  const harnesses = (status.agents ?? []).map((agent) => {
    const models = agent.capabilities?.modelConfigurable
      ? (agent.models ?? []).map((model) => ({
          id: model.id,
          name: model.name ?? model.id,
        }))
      : [];
    const effortOption = agent.capabilities?.configOptions?.find(
      (option) => option.category === "thought_level"
    );
    const efforts = (effortOption?.values ?? []).map((effort) => ({
      id: effort.value,
      name: effort.name ?? effort.value,
    }));
    return {
      kind: agent.kind,
      label: agent.label,
      available: agent.available,
      models,
      selectedModel:
        prefString(prefs, `model.${agent.kind}.assistant`) ||
        prefString(prefs, `model.${agent.kind}.default`) ||
        models[0]?.id ||
        "",
      efforts,
      selectedEffort:
        prefString(prefs, `config.${agent.kind}.assistant.thought_level`) ||
        prefString(prefs, `config.${agent.kind}.default.thought_level`) ||
        effortOption?.currentValue ||
        "",
      supportsAttachments:
        agent.capabilities?.promptImage === true ||
        agent.capabilities?.promptAudio === true ||
        agent.capabilities?.promptEmbeddedContext === true,
      supportsContext: agent.capabilities?.usageUpdateObserved === true,
      sessionReady:
        agent.available &&
        agent.capabilities?.reachable === true &&
        agent.capabilities.authRequired !== true,
      ...(agent.hint ||
      agent.capabilities?.reason ||
      agent.capabilities?.authRequired
        ? {
            hint:
              agent.hint ??
              agent.capabilities?.reason ??
              `${agent.label} requires setup or sign-in.`,
          }
        : {}),
    };
  });
  const selected = harnesses.find((entry) => entry.kind === harnessKind) ??
    harnesses.find((entry) => entry.available) ??
    harnesses[0] ?? {
      kind: harnessKind,
      label: harnessKind,
      available: false,
      models: [],
      selectedModel: "",
      efforts: [],
      selectedEffort: "",
      supportsAttachments: false,
      supportsContext: false,
      sessionReady: false,
      hint: `${harnessKind} did not complete its session preflight.`,
    };
  return {
    harnesses,
    harnessKind: selected.kind,
    models: selected.models,
    selectedModel: selected.selectedModel,
    efforts: selected.efforts,
    selectedEffort: selected.selectedEffort,
    supportsAttachments: selected.supportsAttachments,
    supportsContext: selected.supportsContext,
  };
}

export async function pickAndUploadAssistantAttachment(): Promise<
  AssistantAttachment | undefined
> {
  const picked = await DocumentPicker.getDocumentAsync({
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (picked.canceled) return undefined;
  const asset = picked.assets[0];
  if (!asset) return undefined;
  if (asset.size !== undefined && asset.size > 25 * 1024 * 1024) {
    throw new Error("Attachments must be 25 MB or smaller.");
  }
  const mime = asset.mimeType ?? "application/octet-stream";
  const bytes = new Uint8Array(
    await (await expoFetch(asset.uri)).arrayBuffer()
  );
  const base = await requireGatewayBase();
  const response = await expoFetch(
    `${base}${sessionsPath.replace("/sessions", "/blobs")}`,
    {
      method: "POST",
      headers: apiHeaders({ "content-type": mime }),
      body: bytes,
    }
  );
  if (!response.ok)
    throw new Error(`Attachment upload returned HTTP ${response.status}`);
  const stored = (await response.json()) as { hash: string; sizeBytes: number };
  return {
    hash: stored.hash,
    mime,
    sizeBytes: stored.sizeBytes,
    filename: asset.name,
  };
}

export async function saveAssistantSelection(
  harnessKind: string,
  kind: "model" | "effort",
  value: string
): Promise<void> {
  const base = await requireGatewayBase();
  const key =
    kind === "model"
      ? `model.${harnessKind}.assistant`
      : `config.${harnessKind}.assistant.thought_level`;
  await fetchJson(`${base}/_centraid-user/prefs`, {
    method: "PUT",
    headers: apiHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ patch: { [key]: value || null } }),
  });
}

export async function openAssistantConversation(): Promise<{
  conversationId: string;
  bubbles: AssistantHistoryBubble[];
  harnessKind?: string;
}> {
  const base = await requireGatewayBase();
  const listed = await fetchJson<{
    sessions?: Array<{ id: string }>;
  }>(`${base}${sessionsPath}`, { headers: apiHeaders() });
  let conversationId = listed.sessions?.[0]?.id;
  if (!conversationId) {
    const created = await fetchJson<{ id: string }>(`${base}${sessionsPath}`, {
      method: "POST",
      headers: apiHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ title: "" }),
    });
    conversationId = created.id;
  }
  const transcript = await fetchJson<{
    harnessKind?: string | null;
    messages?: Array<{
      idx: number;
      payload?: { kind?: string; text?: string; error?: boolean };
    }>;
  }>(`${base}${sessionsPath}/${encodeURIComponent(conversationId)}`, {
    headers: apiHeaders(),
  });
  const bubbles = (transcript.messages ?? []).flatMap(
    (message): AssistantHistoryBubble[] => {
      const payload = message.payload;
      if (payload?.kind !== "user" && payload?.kind !== "ai") return [];
      return [
        {
          key: `history-${message.idx}`,
          role: payload.kind === "user" ? "user" : "assistant",
          text: payload.text ?? "",
          ...(payload.error ? { error: true } : {}),
        },
      ];
    }
  );
  return {
    conversationId,
    bubbles,
    ...(transcript.harnessKind ? { harnessKind: transcript.harnessKind } : {}),
  };
}

export async function streamAssistantTurn(
  input: {
    conversationId: string;
    message: string;
    model?: string;
    effort?: string;
    harnessKind?: string;
    attachments?: AssistantAttachment[];
    /** One approved provider, or every provider approved so far this turn (#567). */
    providerConsent?: string | string[];
    idempotencyKey: string;
  },
  onEvent: (event: AssistantTurnEvent) => void,
  signal: AbortSignal
): Promise<{
  consent?: { provider: string; message: string };
  error?: string;
}> {
  const base = await requireGatewayBase();
  const response = await expoFetch(`${base}/centraid/_vault/assistant/_turn`, {
    method: "POST",
    headers: apiHeaders({
      accept: "text/event-stream",
      "content-type": "application/json",
    }),
    body: JSON.stringify({
      conversationId: input.conversationId,
      message: input.message,
      idempotencyKey: input.idempotencyKey,
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { thinking: input.effort } : {}),
      ...(input.harnessKind ? { harnessKind: input.harnessKind } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(input.providerConsent?.length
        ? { providerConsent: input.providerConsent }
        : {}),
    }),
    signal,
  });
  if (!response.ok || !response.body)
    throw new Error(`Assistant returned HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let consent: { provider: string; message: string } | undefined;
  let error: string | undefined;
  const readNext = async (): Promise<void> => {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) {
        try {
          const event = JSON.parse(data) as AssistantTurnEvent;
          if (event.type === "consent.required") {
            consent = { provider: event.provider, message: event.message };
          } else if (event.type === "error") {
            error = event.message;
          } else if (typeof event.type === "string") {
            onEvent(event);
          }
        } catch {
          // Skip one malformed optional frame and keep the turn alive.
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
    return readNext();
  };
  await readNext();
  return {
    ...(consent ? { consent } : {}),
    ...(error ? { error } : {}),
  };
}
