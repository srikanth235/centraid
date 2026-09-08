// governance: allow-repo-hygiene file-size-limit renderer HTTP-client hub pending split per-surface (apps, templates, vault, automations) once the thin-client surface stabilizes
/*
 * Renderer-side HTTP client for the gateway's runtime/data plane. Electron main
 * still owns the credential and hands it over once via `getGatewayAuth()`,
 * cached here and refreshed on gateway switch; local and remote gateways share
 * one wire protocol. This file is the barrel — hence the re-exports at the foot.
 */

import { isGatewayCapabilities, ROUTES } from "@centraid/core/protocol";
import type { GatewayCapabilities, GatewayInfo } from "@centraid/core/protocol";

import {
  auth,
  authHeaders,
  doFetch,
  enc,
  readJson,
} from "./gateway-client-core.js";
import { consumeSse, consumeSseFrames, frameData } from "./turn-stream.js";
import type { TurnStreamEvent } from "./turn-stream.js";

export * from "./gateway-client-core.js";
export * from "./gateway-client-automations.js";
export * from "./gateway-client-automation-compile.js";
export * from "./gateway-client-push.js";

export async function readGatewayCapabilities(): Promise<
  GatewayCapabilities | undefined
> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_gateway/info", {
    method: "GET",
    headers: authHeaders(token),
  });
  const info = await readJson<GatewayInfo>(res, "read gateway capabilities");
  return isGatewayCapabilities(info.capabilities)
    ? info.capabilities
    : undefined;
}

export async function appLogs(input: {
  id: string;
  limit?: number;
  sinceTs?: number;
  level?: CentraidLogLevel;
}): Promise<{ entries: CentraidLogEntry[] }> {
  const { baseUrl, token } = await auth();
  const params = new URLSearchParams();
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  if (input.sinceTs !== undefined) params.set("sinceTs", String(input.sinceTs));
  if (input.level) params.set("level", input.level);
  const qs = params.toString();
  const res = await doFetch(
    baseUrl,
    `/centraid/_apps/${enc(input.id)}/logs${qs ? `?${qs}` : ""}`,
    {
      method: "GET",
      headers: authHeaders(token),
    }
  );
  return readJson<{ entries: CentraidLogEntry[] }>(res, "fetch app logs");
}

export async function appSettings(input: {
  id: string;
}): Promise<CentraidAppSettings> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_apps/${enc(input.id)}/settings`,
    {
      method: "GET",
      headers: authHeaders(token),
    }
  );
  const out = await readJson<{ settings: CentraidAppSettings }>(
    res,
    "fetch app settings"
  );
  return out.settings ?? {};
}

/** `value: null` deletes. Keys go verbatim — the runtime kebab-cases at bake
 *  time — and `__`-prefixed keys are refused gateway-side. */
export async function appSettingWrite(input: {
  id: string;
  key: string;
  value: unknown;
}): Promise<CentraidAppSettings> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_apps/${enc(input.id)}/settings`,
    {
      method: "PUT",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify({ key: input.key, value: input.value ?? null }),
    }
  );
  const out = await readJson<{ settings: CentraidAppSettings }>(
    res,
    "write app setting"
  );
  return out.settings ?? {};
}

export async function deregisterApp(input: {
  id: string;
}): Promise<{ id: string }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_apps/${enc(input.id)}`, {
    method: "DELETE",
    headers: authHeaders(token),
  });
  return readJson<{ id: string }>(res, "deregister");
}

export interface AppMetaEntry {
  id: string;
  name?: string;
  description?: string;
  kind?: "app" | "automation";
  /** Raw strings; validate against the design-token sets before rendering. */
  iconKey?: string;
  colorKey?: string;
}

export async function listApps(): Promise<AppMetaEntry[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_apps`, {
    method: "GET",
    headers: authHeaders(token),
  });
  const out = await readJson<AppMetaEntry[]>(res, "list apps");
  return out ?? [];
}

export interface TemplateVaultScope {
  schema: string;
  table?: string;
  verbs: string;
  rowFilter?: Array<{ column: string; op: string; value?: unknown }>;
  fieldMask?: string[];
}

/** No install/consent sheet renders this (#708): the standing surface for the
 *  same question is the Privacy grants ledger, which can also revoke. */
export interface TemplateVaultDTO {
  purpose?: string;
  why?: string;
  scopes: TemplateVaultScope[];
}

export interface TemplateMetaEntry {
  id: string;
  name: string;
  desc: string;
  colorKey: string;
  iconKey: string;
  version: string;
  kind?: "app" | "automation";
  triggerKind?: "cron" | "webhook" | "data" | "condition";
  triggerLabel?: string;
  installed?: boolean;
  vault?: TemplateVaultDTO;
}

/** Only display metadata crosses the wire: `files`/`source` stay gateway-side. */
export async function listTemplates(): Promise<TemplateMetaEntry[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_templates`, {
    method: "GET",
    headers: authHeaders(token),
  });
  const out = await readJson<TemplateMetaEntry[]>(res, "list templates");
  return out ?? [];
}

export interface DailyBrief {
  date: string;
  events: Array<{ id: string; title: string; at: string }>;
  tasks: Array<{ id: string; title: string; dueAt: string }>;
  newPhotos: number;
  balanceMinor: number;
  currency: string;
}

export async function getDailyBrief(now = new Date()): Promise<DailyBrief> {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const params = new URLSearchParams({
    date: [
      start.getFullYear(),
      String(start.getMonth() + 1).padStart(2, "0"),
      String(start.getDate()).padStart(2, "0"),
    ].join("-"),
    from: start.toISOString(),
    to: end.toISOString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  });
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `${ROUTES.briefToday}?${params}`, {
    method: "GET",
    headers: authHeaders(token),
  });
  return readJson<DailyBrief>(res, "fetch daily brief");
}

// ─── Versions (git-store tag history) ─────

interface GitVersion {
  tag: string;
  version: number;
  sha: string;
  uploadedAt: string;
  active: boolean;
}

/** The ACTIVE tag is not necessarily the newest one — a rollback moves it. */
export async function listVersions(input: {
  id: string;
}): Promise<{ activeVersion?: string; versions: CentraidVersionRecord[] }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_apps/${enc(input.id)}/git-versions`,
    {
      method: "GET",
      headers: authHeaders(token),
    }
  );
  // The gateway 404s until the first publish lands a tag; that is an empty list.
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    return { versions: [] };
  }
  const out = await readJson<{ versions: GitVersion[] }>(res, "list versions");
  const list = out.versions ?? [];
  if (list.length === 0) return { versions: [] };
  const activeEntry = list.find((v) => v.active);
  const versions: CentraidVersionRecord[] = list.map((v) => ({
    versionId: v.tag,
    sha256: v.sha,
    declaredVersion: String(v.version),
    uploadedAt: v.uploadedAt,
    bytes: 0,
    files: 0,
    ...(v.active ? { current: true } : {}),
  }));
  return {
    versions,
    ...(activeEntry ? { activeVersion: activeEntry.tag } : {}),
  };
}

export async function activateVersion(input: {
  id: string;
  versionId: string;
}): Promise<{ activeVersion: string }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_apps/${enc(input.id)}/rollback`,
    {
      method: "POST",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify({ versionTag: input.versionId }),
    }
  );
  await readJson<{ id: string; sha: string }>(res, "activate version");
  return { activeVersion: input.versionId };
}

// ─── User identity + global prefs (`/_centraid-user`) ─────

export async function getUserId(): Promise<string> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/_centraid-user/id`, {
    method: "GET",
    headers: authHeaders(token),
  });
  const out = await readJson<{ id: string }>(res, "fetch user id");
  return out.id;
}

export async function getUserPrefs(): Promise<Record<string, unknown>> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/_centraid-user/prefs`, {
    method: "GET",
    headers: authHeaders(token),
  });
  const out = await readJson<{ prefs: Record<string, unknown> }>(
    res,
    "fetch user prefs"
  );
  return out.prefs ?? {};
}

export async function saveUserPrefs(
  patch: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/_centraid-user/prefs`, {
    method: "PUT",
    headers: authHeaders(token, "application/json"),
    body: JSON.stringify({ patch }),
  });
  const out = await readJson<{ prefs: Record<string, unknown> }>(
    res,
    "save user prefs"
  );
  return out.prefs ?? {};
}

// ─── Automations + insights (`/centraid/_automations`, `/centraid/_insights`) ─────
// A turn-now fires on the GATEWAY host, with its harness and provider key.

export async function listAutomations(): Promise<CentraidAutomationRow[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_automations`, {
    method: "GET",
    headers: authHeaders(token),
  });
  const out = await readJson<{ rows: CentraidAutomationRow[] }>(
    res,
    "list automations"
  );
  return out.rows ?? [];
}

export async function readAutomation(input: {
  automationId: string;
}): Promise<CentraidAutomationRow | null> {
  // A valid ref is `<appId>/<id>`, so anything without a slash cannot resolve.
  if (!input.automationId.includes("/")) return null;
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_automations/read?ref=${enc(input.automationId)}`,
    {
      method: "GET",
      headers: authHeaders(token),
    }
  );
  const out = await readJson<{ row: CentraidAutomationRow | null }>(
    res,
    "read automation"
  ).catch(() => ({ row: null }));
  return out.row ?? null;
}

export async function runAutomationNow(input: {
  automationId: string;
}): Promise<CentraidAutomationTurnResult> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_automations/turn-now?ref=${enc(input.automationId)}`,
    { method: "POST", headers: authHeaders(token) }
  );
  return readJson<CentraidAutomationTurnResult>(res, "run automation");
}

/** The synchronous seam; `runAutomationNow` stays the background/SSE one. */
export async function invokeAutomationAndAwait(input: {
  automationId: string;
  payload?: unknown;
}): Promise<CentraidAutomationInvokeResult> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_automations/invoke-and-await?ref=${enc(input.automationId)}`,
    {
      method: "POST",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify(input.payload ?? {}),
    }
  );
  const result = await readJson<CentraidAutomationInvokeResult>(
    res,
    "invoke automation and await"
  );
  if (result.result.outcome && !result.result.outcome.ok) {
    throw new Error(
      result.result.outcome.error ?? "Automation finished unsuccessfully."
    );
  }
  return result;
}

export async function listAutomationTurns(input: {
  automationId?: string;
  limit?: number;
}): Promise<CentraidAutomationTurnRecord[]> {
  const { baseUrl, token } = await auth();
  const params = new URLSearchParams();
  if (input.automationId) params.set("ref", input.automationId);
  params.set("limit", String(input.limit ?? 50));
  const res = await doFetch(
    baseUrl,
    `/centraid/_automations/turns?${params.toString()}`,
    {
      method: "GET",
      headers: authHeaders(token),
    }
  );
  const out = await readJson<{ turns: CentraidAutomationTurnRecord[] }>(
    res,
    "list turns"
  );
  return out.turns ?? [];
}

export async function readAutomationTurn(input: {
  turnId: string;
}): Promise<CentraidAutomationTurnRecord | null> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_automations/turn?turnId=${enc(input.turnId)}`,
    {
      method: "GET",
      headers: authHeaders(token),
    }
  );
  const out = await readJson<{ turn: CentraidAutomationTurnRecord | null }>(
    res,
    "read turn"
  );
  return out.turn ?? null;
}

export async function readAutomationTurnExpanded(input: {
  turnId: string;
}): Promise<{
  turn: CentraidAutomationTurnRecord | null;
  items: CentraidAutomationItem[];
}> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_automations/turn?turnId=${enc(input.turnId)}&expand=items`,
    { method: "GET", headers: authHeaders(token) }
  );
  const out = await readJson<{
    turn: CentraidAutomationTurnRecord | null;
    items?: CentraidAutomationItem[];
  }>(res, "read expanded turn");
  return { turn: out.turn ?? null, items: out.items ?? [] };
}

export async function readLatestAutomationTurnExpanded(input: {
  automationId: string;
}): Promise<{
  turn: CentraidAutomationTurnRecord | null;
  items: CentraidAutomationItem[];
}> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_automations/turn?ref=${enc(input.automationId)}&expand=items`,
    { method: "GET", headers: authHeaders(token) }
  );
  const out = await readJson<{
    turn: CentraidAutomationTurnRecord | null;
    items?: CentraidAutomationItem[];
  }>(res, "read latest expanded turn");
  return { turn: out.turn ?? null, items: out.items ?? [] };
}

export async function listAutomationItems(input: {
  turnId: string;
}): Promise<CentraidAutomationItem[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_automations/turn/items?turnId=${enc(input.turnId)}`,
    {
      method: "GET",
      headers: authHeaders(token),
    }
  );
  const out = await readJson<{ items: CentraidAutomationItem[] }>(
    res,
    "turn items"
  );
  return out.items ?? [];
}

/** `item.delta` nests the same `TurnStreamEvent` grammar as conversations. */
export type AutomationTurnStreamEvent =
  | { type: "turn.start"; turnId: string }
  | {
      type: "item.start";
      itemId: string;
      ordinal: number;
      callId?: string;
      batchId?: number;
      kind: CentraidAutomationItem["kind"];
      name?: string;
      args?: unknown;
      rawJson?: string;
    }
  | {
      type: "item.delta";
      itemId: string;
      ordinal: number;
      callId?: string;
      event: unknown;
    }
  | {
      type: "item.end";
      itemId: string;
      ordinal: number;
      callId?: string;
      ok: boolean;
      result?: unknown;
      error?: string;
      durationMs: number;
      rawJson?: string;
    }
  | { type: "turn.end"; turnId: string; ok: boolean; error?: string };

/** An abort resolves quietly; other failures reject so a caller can fall back. */
export async function streamAutomationTurn(
  turnId: string,
  onEvent: (ev: AutomationTurnStreamEvent) => void,
  signal: AbortSignal
): Promise<void> {
  const { baseUrl, token } = await auth();
  try {
    const res = await doFetch(
      baseUrl,
      `/centraid/_automations/turn/events?turnId=${enc(turnId)}`,
      {
        method: "GET",
        headers: authHeaders(token),
        signal,
      }
    );
    if (!res.ok || !res.body) {
      throw new Error(`run events stream failed (HTTP ${res.status})`);
    }
    await consumeSseFrames(
      res.body,
      (frame) => {
        const data = frameData(frame);
        if (!data) return;
        try {
          const evt = JSON.parse(data) as { type?: string };
          if (evt && typeof evt.type === "string")
            onEvent(evt as AutomationTurnStreamEvent);
        } catch {
          /* skip a malformed frame rather than abort the stream */
        }
      },
      { signal }
    );
  } catch (error) {
    // A caller-initiated abort is a normal teardown, not a failure.
    if (signal.aborted) return;
    throw error;
  }
}

/** The new turn id arrives in a response header, for one expanded re-read. */
export async function streamAutomationConversationTurn(
  automationId: string,
  message: string,
  onEvent: (event: TurnStreamEvent) => void,
  signal: AbortSignal,
  /** One approved provider, or every provider approved so far this attempt (#567). */
  providerConsent?: string | string[],
  turn?: {
    attachments?: Array<{
      hash: string;
      mime: string;
      sizeBytes: number;
      filename?: string;
    }>;
    harnessKind?: string;
    model?: string;
    thinking?: string;
  }
): Promise<{ turnId?: string; ended: boolean }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_automations/turn?ref=${enc(automationId)}`,
    {
      method: "POST",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify({
        message,
        ...(providerConsent?.length ? { providerConsent } : {}),
        ...(turn?.attachments?.length ? { attachments: turn.attachments } : {}),
        ...(turn?.harnessKind ? { harnessKind: turn.harnessKind } : {}),
        ...(turn?.model ? { model: turn.model } : {}),
        ...(turn?.thinking ? { thinking: turn.thinking } : {}),
      }),
      signal,
    }
  );
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `interactive automation turn failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`
    );
  }
  const turnId = res.headers.get("x-centraid-turn-id") ?? undefined;
  const result = await consumeSse(res.body, onEvent, { signal });
  return { ...result, ...(turnId ? { turnId } : {}) };
}

export async function pinAutomationTurn(input: {
  turnId: string;
  pinned: boolean;
}): Promise<{ ok: true }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_automations/turn/pin?turnId=${enc(input.turnId)}`,
    {
      method: "POST",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify({ pinned: input.pinned }),
    }
  );
  await readJson(res, "pin turn");
  return { ok: true };
}

export async function getInsightsSummary(input?: {
  windowDays?: number;
}): Promise<CentraidInsightsSummary> {
  const { baseUrl, token } = await auth();
  const qs =
    input?.windowDays === undefined
      ? ""
      : `?windowDays=${enc(String(input.windowDays))}`;
  const res = await doFetch(baseUrl, `/centraid/_insights/summary${qs}`, {
    method: "GET",
    headers: authHeaders(token),
  });
  return readJson<CentraidInsightsSummary>(res, "insights summary");
}

export async function getGatewayHealth(): Promise<CentraidGatewayHealth> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_gateway/health", {
    method: "GET",
    headers: authHeaders(token),
  });
  return readJson<CentraidGatewayHealth>(res, "gateway health");
}

/** Absent `durationMs` ⇒ indefinite (`until: null`); the gateway clamps to 24h. */
export async function pauseBackgroundWork(
  durationMs?: number
): Promise<{ paused: boolean; until: string | null }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_gateway/resource/pause", {
    method: "POST",
    headers: authHeaders(token, "application/json"),
    body: JSON.stringify(durationMs === undefined ? {} : { durationMs }),
  });
  return readJson<{ paused: boolean; until: string | null }>(
    res,
    "pause background work"
  );
}

export async function resumeBackgroundWork(): Promise<{ paused: boolean }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_gateway/resource/pause", {
    method: "DELETE",
    headers: authHeaders(token),
  });
  return readJson<{ paused: boolean }>(res, "resume background work");
}

// ───────────────────────── editing + lifecycle ─────────────────────
// Split for the file-size limit; re-exported so this stays the one barrel.
export * from "./gateway-client-editing.js";
export * from "./gateway-client-automation-editing.js";

export * from "./gateway-client-conversation.js";

export * from "./gateway-client-vault.js";
// The staged-import half: one lifecycle, not one act per call.
export * from "./gateway-client-vault-imports.js";
export * from "./gateway-client-atlas.js";

export * from "./gateway-client-connections.js";

export * from "./gateway-client-outbox.js";

export * from "./gateway-client-logs.js";

export * from "./gateway-client-backup.js";

export * from "./gateway-client-storage.js";

// The LOCAL disk surface: same route prefix as storage, different question.
export * from "./gateway-client-local-storage.js";

export {
  listGatewayDevices,
  revokeGatewayDevice,
  renameGatewayDevice,
  createGatewayDeviceTicket,
  setGatewayDeviceCompute,
  getGatewayDeviceWorkStatus,
  leaseGatewayDeviceWork,
  finishGatewayDeviceWork,
  readGatewayDeviceWorkSource,
  releaseGatewayDeviceWork,
  stageGatewayDeviceWorkDerivative,
  type CentraidGatewayDevice,
  type GatewayDeviceVault,
  type DeviceComputeCapabilities,
  type DeviceComputeProfile,
  type GatewayDeviceWorkDepth,
  type DeviceEnrichmentLease,
  type GatewayDeviceTicket,
  type GatewayDeviceTicketInput,
} from "./gateway-client-devices.js";

// On its own leaf: a screen asks this without importing the HTTP client.
export { isRevokedDevice } from "./device-roster.js";

export {
  listGatewayOwners,
  renameGatewayOwner,
  type GatewayOwner,
  type GatewayOwnerVault,
} from "./gateway-client-owners.js";

// D9's per-link receive setting is deliberately NOT here: it would govern gives
// arriving from another person's vault, and there is no copy-as-share (#825).
export {
  listGatewayLinks,
  proposeGatewayLink,
  approveGatewayLink,
  type GatewayLink,
} from "./gateway-client-links.js";
export {
  listGatewayEdges,
  type GatewayEdge,
  type EdgeMode,
  type EdgeKind,
  type EdgeStatus,
} from "./gateway-client-edges.js";
