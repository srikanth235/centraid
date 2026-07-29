// governance: allow-repo-hygiene file-size-limit renderer HTTP-client hub pending split per-surface (apps, templates, vault, automations) once the thin-client surface stabilizes
/*
 * Renderer-side HTTP client for the gateway's runtime/data plane.
 *
 * Thin-client pivot: the renderer talks to the active gateway directly
 * over HTTP with a Bearer token, instead of relaying each call through
 * the Electron main process. Main still owns the credential — it reads
 * the active gateway's `{ baseUrl, token }` from keychain-backed settings
 * and hands it over once via `getGatewayAuth()`; we cache it and refresh
 * on gateway switch. The local embedded gateway answers on loopback; a
 * remote gateway answers on its URL — identical wire protocol either way
 * (the local server now emits CORS for the `file://` renderer origin).
 *
 * This module ports the pure `fetch` methods that previously lived in
 * `main/*-client.ts` + `@centraid/agent-harness`'s `gateway-client`.
 * It covers the app read surface (logs / settings / deregister / live
 * URL — the schema/table-rows/query trio died with the per-app
 * data.sqlite, issue #286 phase 2), version history (list / activate), the
 * `/_centraid-user` identity + prefs surface, and the automation
 * read/run/analytics + insights surface. The shared fetch infrastructure
 * lives in `gateway-client-core.ts`; the app-editing + lifecycle surface
 * in `gateway-client-editing.ts` — both re-exported here so call sites
 * import everything from `./gateway-client.js`.
 */

import {
  consumeSse,
  consumeSseFrames,
  frameData,
} from "@centraid/blueprints/kit/turn-stream.js";
import type { TurnStreamEvent } from "@centraid/blueprints/kit/turn-stream.js";
import { isGatewayCapabilities } from "@centraid/protocol";
import type { GatewayCapabilities, GatewayInfo } from "@centraid/protocol";

import {
  appSessionUrl,
  auth,
  authHeaders,
  doFetch,
  enc,
  readJson,
} from "./gateway-client-core.js";

export * from "./gateway-client-core.js";
export * from "./gateway-client-automation-compile.js";

/** Feature flags advertised by the active gateway, or undefined if malformed. */
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

/** URL the renderer loads in an app iframe. */
export async function appLiveUrl(input: {
  id: string;
}): Promise<{ url: string }> {
  return { url: await appSessionUrl(input.id, `/centraid/${enc(input.id)}/`) };
}

/** Newest-first tail of persistent handler logs. */
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

/**
 * All app-owned `settings.json` values for the app (issue #286 phase 2:
 * the per-app data.sqlite's `__centraid_settings` table became this
 * file). Knob keys are the manifest's camelCase `app*` names.
 */
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

/**
 * Write one app-owned settings key; `value: null` deletes it. Keys are
 * sent verbatim (camelCase `app*` — the runtime kebab-cases at bake
 * time); `__`-prefixed keys are runtime-owned and refused gateway-side.
 * Returns the full settings map after the write.
 */
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

/** Remove an app from the registry. */
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

/** Apps on `main` + their display metadata (the `GET /centraid/_apps` row). */
export interface AppMetaEntry {
  id: string;
  name?: string;
  description?: string;
  kind?: "app" | "automation";
  hasIndex: boolean;
  /** Tile identity from `app.json` (issue #263) — raw strings; validate
   *  against the design-tokens sets before rendering. */
  iconKey?: string;
  colorKey?: string;
}

/**
 * Apps published on `main`, with the metadata the home shelf reads. The
 * git store is the source of truth post-#137 — there's no local worktree
 * to stat — so this returns the registry-backed metadata row, not the
 * legacy `CentraidAppInfo` (the renderer only reads id/name/desc/kind/
 * hasIndex off it).
 */
export async function listApps(): Promise<AppMetaEntry[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_apps`, {
    method: "GET",
    headers: authHeaders(token),
  });
  const out = await readJson<AppMetaEntry[]>(res, "list apps");
  return out ?? [];
}

/** One requested scope of a template's `app.json` `vault` block. */
export interface TemplateVaultScope {
  schema: string;
  table?: string;
  verbs: string;
  rowFilter?: Array<{ column: string; op: string; value?: unknown }>;
  fieldMask?: string[];
}

/** A template's requested vault access, for the Discover install/consent sheet
 *  (issue #434). Read from the app-kind template's `app.json`; automations omit
 *  it. `why` is the owner-facing sentence; `scopes` are what it will touch. */
export interface TemplateVaultDTO {
  purpose?: string;
  why?: string;
  scopes: TemplateVaultScope[];
}

/** Display metadata for one bundled template (the `GET /centraid/_templates` row). */
export interface TemplateMetaEntry {
  id: string;
  name: string;
  desc: string;
  colorKey: string;
  iconKey: string;
  version: string;
  kind?: "app" | "automation";
  /** Automation trigger presentation mirrors the bundled app metadata. */
  triggerKind?: "cron" | "webhook" | "data" | "condition";
  triggerLabel?: string;
  /**
   * Whether this bundled app is already installed in the addressed vault
   * (issue #434). Present only when the gateway resolves per-vault install
   * state; the Discover gallery shows "Open" when true, "Install" otherwise.
   */
  installed?: boolean;
  /**
   * Requested vault access (issue #434). Present for app-kind templates whose
   * `app.json` declares a `vault` block; the install sheet renders it as the
   * consent surface before the owner installs.
   */
  vault?: TemplateVaultDTO;
}

/**
 * Bundled template catalog, resolved gateway-side (bundle-or-cache). Only
 * display metadata crosses the wire — the renderer casts this to its own
 * `TemplateEntry`. The clone path still reads template files gateway-side,
 * so `files`/`source` never reach the renderer.
 */
export async function listTemplates(): Promise<TemplateMetaEntry[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_templates`, {
    method: "GET",
    headers: authHeaders(token),
  });
  const out = await readJson<TemplateMetaEntry[]>(res, "list templates");
  return out ?? [];
}

// ---- Versions (git-store tag history) ----

/** Raw tag-driven version entry from the git store, newest-first. */
interface GitVersion {
  tag: string;
  version: number;
  sha: string;
  uploadedAt: string;
  /** `true` iff this tag's subtree matches the one currently on main. */
  active: boolean;
}

/**
 * Version history for the app, shaped for the renderer's version list.
 * Mirrors the old VERSIONS_LIST IPC handler: the git store marks the
 * active tag explicitly (`active: true` on the entry whose subtree
 * matches main — after a rollback that's NOT necessarily the newest
 * tag), which becomes `current` per-row + the top-level `activeVersion`.
 */
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
  // The app may have no tags yet (never published) — the gateway 404s
  // until the first publish lands a tag; treat that as an empty list.
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

/**
 * Roll the app back to an existing version tag (forward-only overlay).
 * `versionId` is the version tag returned by `listVersions`; we report
 * it back as the new active version.
 */
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

// ---- User identity + global prefs (`/_centraid-user`) ----

/** Stable user UUID, generated gateway-side on first read. */
export async function getUserId(): Promise<string> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/_centraid-user/id`, {
    method: "GET",
    headers: authHeaders(token),
  });
  const out = await readJson<{ id: string }>(res, "fetch user id");
  return out.id;
}

/** Snapshot of every gateway-side global preference. */
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

/**
 * Merge `patch` into the gateway-side prefs store; returns the full map.
 *
 * The old IPC handler also called `noteRunnerPrefsChanged()` to drop the
 * main process's in-memory preflight cache. That's no longer needed from
 * here: the preflight cache keys on the runner prefs that matter
 * (kind / binPath / provider id+baseUrl+envKey), so a change to any of
 * them re-probes automatically; and the runner-status panel
 * (`getRunnerStatus`) force-invalidates before every read regardless.
 */
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

// ---- Automations + insights (`/centraid/_automations`, `/centraid/_insights`) ----
// Read/run/analytics proxies. Code (manifests) resolves gateway-side from
// the materialized `main`; run ledgers + analytics from the gateway's data
// dir. A turn-now fires on the gateway host with ITS runner + provider key.

/** Every automation on `main`, sorted by name. */
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

/** One automation by its `<appId>/<id>` ref, or `null` when absent/invalid. */
export async function readAutomation(input: {
  automationId: string;
}): Promise<CentraidAutomationRow | null> {
  // Mirror the old handler's `parseAutomationRef` guard: a valid ref is
  // `<appId>/<id>`, so anything without a slash can't resolve.
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

/** Fire an automation now on the gateway host; returns the minted turn id. */
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

/** Native automation turns, newest-first. Omit `automationId` for the global feed. */
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

/** One native turn from the shared ledger, or `null` when unknown. */
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

/** One turn and its items in one authoritative ledger snapshot. */
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

/** Latest turn for an automation, expanded with its native items. */
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

/** The turn's native item timeline from the shared ledger. */
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

/**
 * Live native automation-turn event. `item.delta` nests the same
 * `TurnStreamEvent` grammar used by interactive conversations.
 */
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

/**
 * Subscribe to a turn's live events over SSE. The gateway replays the
 * durable ledger snapshot, then streams live until `turn.end`. `onEvent` fires
 * per parsed event; the promise resolves when the stream closes. Pass an
 * `AbortSignal` to detach (panel teardown). An abort resolves quietly; other
 * transport failures reject so the caller can fall back to a one-shot read.
 */
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

/**
 * Execute a one-off interactive turn in an automation's durable
 * conversation. The stream is the exact shared `TurnStreamEvent` grammar;
 * the gateway exposes the new native turn id in a response header so the
 * caller can perform one authoritative expanded re-read on completion.
 */
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
    runnerKind?: string;
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
        ...(turn?.runnerKind ? { runnerKind: turn.runnerKind } : {}),
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

/** Pin / unpin a run as a replay fixture (ledger + central summary). */
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

/** The Insights screen's analytics payload over the central run ledger. */
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

/**
 * Component-level gateway health (`GET /centraid/_gateway/health`):
 * per-subsystem status (vaults, schedulers, outbox, connections, …), each
 * component's last error, and the gateway's recent structured warn/error
 * tail. Backs the Gateway page's Components tab (and its Overview orb's
 * reconciled status, via useGatewayHealth's poll).
 */
export async function getGatewayHealth(): Promise<CentraidGatewayHealth> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_gateway/health", {
    method: "GET",
    headers: authHeaders(token),
  });
  return readJson<CentraidGatewayHealth>(res, "gateway health");
}

/**
 * Hot-apply a background-work pause (issue #528 Phase B). `durationMs` absent
 * ⇒ an indefinite pause (`until: null`); the gateway clamps to a 24h max.
 * Returns the reconciled pause state — same shape health reports under
 * `metrics.backgroundPause`.
 */
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

/** Lift a background-work pause (issue #528 Phase B). */
export async function resumeBackgroundWork(): Promise<{ paused: boolean }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_gateway/resource/pause", {
    method: "DELETE",
    headers: authHeaders(token),
  });
  return readJson<{ paused: boolean }>(res, "resume background work");
}

// ───────────────────────── editing + lifecycle ─────────────────────
// The app-editing (sessions / files / publish) + lifecycle (create / clone
// / meta / automation CRUD) surface lives in `gateway-client-editing.ts`
// (split out for the repo file-size limit). Re-exported here so call sites
// keep importing everything from `./gateway-client.js`.
export * from "./gateway-client-editing.js";
export * from "./gateway-client-automation-editing.js";

// The unified chat transport (SSE turn streaming + chat-history surface)
// lives in `gateway-client-conversation.ts` (issue #141, Phase 3). Re-exported here
// so the chat panel imports it from the same barrel.
export * from "./gateway-client-conversation.js";

// The owner consent surface over the mounted vault plane (duaility §12)
// lives in `gateway-client-vault.ts`. Re-exported here so the per-app
// Vault tab imports it from the same barrel.
export * from "./gateway-client-vault.js";
export * from "./gateway-client-atlas.js";

// The broker-owned OAuth / BYO-client connections surface (issue #304)
// lives in `gateway-client-connections.ts`. Re-exported here so the
// Settings → Connections screen imports it from the same barrel.
export * from "./gateway-client-connections.js";

// The outbox / blocking-inbox / standing-grant surface (issues #306, #308)
// lives in `gateway-client-outbox.ts`. Re-exported here so the Approvals
// screen imports it from the same barrel.
export * from "./gateway-client-outbox.js";

// The gateway's realtime log surface lives in `gateway-client-logs.ts`.
// Re-exported here so the Settings → Logs screen imports it from the
// same barrel.
export * from "./gateway-client-logs.js";

// The offsite backup engine's status/run surface (issue #351) lives in
// `gateway-client-backup.ts`. Re-exported here so the Gateway page's
// Backup card imports it from the same barrel.
export * from "./gateway-client-backup.js";

// The gateway-level storage-connection surface (issue #367 §C1/§D) lives in
// `gateway-client-storage.ts`. Re-exported here so the Gateway page's
// Storage card and the Settings → Storage screen import it from the same
// barrel.
export * from "./gateway-client-storage.js";

// The LOCAL disk surface (issue #544) — footprint by component + the owner's
// two limits. Same route prefix, different question; see the module header.
export * from "./gateway-client-local-storage.js";

// The paired-device roster + revoke surface (issue #376) lives in
// `gateway-client-devices.ts`. Re-exported here so the Gateway page's
// Devices card imports it from the same barrel.
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
  type GatewayDeviceRole,
  type GatewayVaultGrant,
  type DeviceComputeCapabilities,
  type DeviceComputeProfile,
  type GatewayDeviceWorkDepth,
  type DeviceEnrichmentLease,
  type GatewayDeviceTicket,
  type GatewayDeviceTicketInput,
} from "./gateway-client-devices.js";

// The tombstone predicate lives on its own leaf so screens can ask "is this
// row revoked?" without importing the HTTP client (see the module header).
export { isRevokedDevice } from "./device-roster.js";

// The household roster (issue #599 L2) — the people devices act as. Same
// card, same barrel; see `gateway-client-members.ts` for the two-verb split.
export {
  listGatewayMembers,
  createGatewayMember,
  renameGatewayMember,
  removeGatewayMember,
  type GatewayMember,
} from "./gateway-client-members.js";
