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
 * It covers the app read surface (schema / table-rows / query / logs /
 * deregister / live URL), version history (list / activate), the
 * `/_centraid-user` identity + prefs surface, and the automation
 * read/run/analytics + insights surface. The shared fetch infrastructure
 * lives in `gateway-client-core.ts`; the app-editing + lifecycle surface
 * in `gateway-client-editing.ts` — both re-exported here so call sites
 * import everything from `./gateway-client.js`.
 */

import { auth, authHeaders, doFetch, enc, href, readJson } from './gateway-client-core.js';

export * from './gateway-client-core.js';

/** URL the renderer loads in an app iframe. */
export async function appLiveUrl(input: { id: string }): Promise<{ url: string }> {
  const { baseUrl } = await auth();
  return { url: href(baseUrl, `/centraid/${enc(input.id)}/`) };
}

/**
 * Live `data.sqlite` schema for the Cloud → Database panel. `undefined`
 * when the app isn't registered (404) or has no active version (503).
 */
export async function appSchema(input: { id: string }): Promise<CentraidAppSchema | undefined> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_apps/${enc(input.id)}/schema`, {
    method: 'GET',
    headers: authHeaders(token),
  });
  if (res.status === 404 || res.status === 503) {
    await res.body?.cancel().catch(() => {});
    return undefined;
  }
  return readJson<CentraidAppSchema>(res, 'fetch app schema');
}

/** One page of rows from a table/view; gateway caps `limit` at 200. */
export async function appTableRows(input: {
  id: string;
  table: string;
  limit?: number;
  offset?: number;
}): Promise<CentraidAppTableRows> {
  const { baseUrl, token } = await auth();
  const params = new URLSearchParams();
  if (input.limit !== undefined) params.set('limit', String(input.limit));
  if (input.offset !== undefined) params.set('offset', String(input.offset));
  const qs = params.toString();
  const res = await doFetch(
    baseUrl,
    `/centraid/_apps/${enc(input.id)}/data/${enc(input.table)}${qs ? `?${qs}` : ''}`,
    { method: 'GET', headers: authHeaders(token) },
  );
  return readJson<CentraidAppTableRows>(res, 'fetch table rows');
}

/** Run one SQL statement against the app's `data.sqlite`. */
export async function appQuery(input: {
  id: string;
  sql: string;
}): Promise<CentraidRunQueryResult> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_apps/${enc(input.id)}/query`, {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({ sql: input.sql }),
  });
  return readJson<CentraidRunQueryResult>(res, 'run query');
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
  if (input.limit !== undefined) params.set('limit', String(input.limit));
  if (input.sinceTs !== undefined) params.set('sinceTs', String(input.sinceTs));
  if (input.level) params.set('level', input.level);
  const qs = params.toString();
  const res = await doFetch(baseUrl, `/centraid/_apps/${enc(input.id)}/logs${qs ? `?${qs}` : ''}`, {
    method: 'GET',
    headers: authHeaders(token),
  });
  return readJson<{ entries: CentraidLogEntry[] }>(res, 'fetch app logs');
}

/** Remove an app from the registry. */
export async function deregisterApp(input: { id: string }): Promise<{ id: string }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_apps/${enc(input.id)}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  return readJson<{ id: string }>(res, 'deregister');
}

/** Apps on `main` + their display metadata (the `GET /centraid/_apps` row). */
export interface AppMetaEntry {
  id: string;
  name?: string;
  description?: string;
  kind?: 'app' | 'automation';
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
    method: 'GET',
    headers: authHeaders(token),
  });
  const out = await readJson<AppMetaEntry[]>(res, 'list apps');
  return out ?? [];
}

/** Display metadata for one bundled template (the `GET /centraid/_templates` row). */
export interface TemplateMetaEntry {
  id: string;
  name: string;
  desc: string;
  colorKey: string;
  iconKey: string;
  version: string;
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
    method: 'GET',
    headers: authHeaders(token),
  });
  const out = await readJson<TemplateMetaEntry[]>(res, 'list templates');
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
  const res = await doFetch(baseUrl, `/centraid/_apps/${enc(input.id)}/git-versions`, {
    method: 'GET',
    headers: authHeaders(token),
  });
  // The app may have no tags yet (never published) — the gateway 404s
  // until the first publish lands a tag; treat that as an empty list.
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    return { versions: [] };
  }
  const out = await readJson<{ versions: GitVersion[] }>(res, 'list versions');
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
  const res = await doFetch(baseUrl, `/centraid/_apps/${enc(input.id)}/rollback`, {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({ versionTag: input.versionId }),
  });
  await readJson<{ id: string; sha: string }>(res, 'activate version');
  return { activeVersion: input.versionId };
}

// ---- User identity + global prefs (`/_centraid-user`) ----

/** Stable user UUID, generated gateway-side on first read. */
export async function getUserId(): Promise<string> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/_centraid-user/id`, {
    method: 'GET',
    headers: authHeaders(token),
  });
  const out = await readJson<{ id: string }>(res, 'fetch user id');
  return out.id;
}

/** Snapshot of every gateway-side global preference. */
export async function getUserPrefs(): Promise<Record<string, unknown>> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/_centraid-user/prefs`, {
    method: 'GET',
    headers: authHeaders(token),
  });
  const out = await readJson<{ prefs: Record<string, unknown> }>(res, 'fetch user prefs');
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
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/_centraid-user/prefs`, {
    method: 'PUT',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({ patch }),
  });
  const out = await readJson<{ prefs: Record<string, unknown> }>(res, 'save user prefs');
  return out.prefs ?? {};
}

// ---- Automations + insights (`/centraid/_automations`, `/centraid/_insights`) ----
// Read/run/analytics proxies. Code (manifests) resolves gateway-side from
// the materialized `main`; run ledgers + analytics from the gateway's data
// dir. A run-now fires on the gateway host with ITS runner + provider key.

/** Every automation on `main`, sorted by name. */
export async function listAutomations(): Promise<CentraidAutomationRow[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_automations`, {
    method: 'GET',
    headers: authHeaders(token),
  });
  const out = await readJson<{ rows: CentraidAutomationRow[] }>(res, 'list automations');
  return out.rows ?? [];
}

/** One automation by its `<appId>/<id>` ref, or `null` when absent/invalid. */
export async function readAutomation(input: {
  automationId: string;
}): Promise<CentraidAutomationRow | null> {
  // Mirror the old handler's `parseAutomationRef` guard: a valid ref is
  // `<appId>/<id>`, so anything without a slash can't resolve.
  if (!input.automationId.includes('/')) return null;
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_automations/read?ref=${enc(input.automationId)}`, {
    method: 'GET',
    headers: authHeaders(token),
  });
  const out = await readJson<{ row: CentraidAutomationRow | null }>(res, 'read automation').catch(
    () => ({ row: null }),
  );
  return out.row ?? null;
}

/** Fire an automation now on the gateway host; returns the minted run id. */
export async function runAutomationNow(input: {
  automationId: string;
}): Promise<CentraidAutomationRunResult> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_automations/run-now?ref=${enc(input.automationId)}`,
    { method: 'POST', headers: authHeaders(token) },
  );
  return readJson<CentraidAutomationRunResult>(res, 'run automation');
}

/** Central run-summary feed, newest-first. Omit `automationId` for the global feed. */
export async function listAutomationRuns(input: {
  automationId?: string;
  limit?: number;
}): Promise<CentraidAutomationRunRecord[]> {
  const { baseUrl, token } = await auth();
  const params = new URLSearchParams();
  if (input.automationId) params.set('ref', input.automationId);
  params.set('limit', String(input.limit ?? 50));
  const res = await doFetch(baseUrl, `/centraid/_automations/runs?${params.toString()}`, {
    method: 'GET',
    headers: authHeaders(token),
  });
  const out = await readJson<{ runs: CentraidAutomationRunRecord[] }>(res, 'list runs');
  return out.runs ?? [];
}

/** One run's full record from its app's ledger, or `null` when unknown. */
export async function readAutomationRun(input: {
  runId: string;
}): Promise<CentraidAutomationRunRecord | null> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_automations/run?runId=${enc(input.runId)}`, {
    method: 'GET',
    headers: authHeaders(token),
  });
  const out = await readJson<{ run: CentraidAutomationRunRecord | null }>(res, 'read run');
  return out.run ?? null;
}

/** The run's node timeline from its app's ledger. */
export async function listAutomationRunNodes(input: {
  runId: string;
}): Promise<CentraidAutomationRunNode[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_automations/run/nodes?runId=${enc(input.runId)}`, {
    method: 'GET',
    headers: authHeaders(token),
  });
  const out = await readJson<{ nodes: CentraidAutomationRunNode[] }>(res, 'run nodes');
  return out.nodes ?? [];
}

/**
 * Live run-stream event (issue #158), mirroring `@centraid/app-engine`'s
 * `RunStreamEvent`. `node.delta` carries chat-parity token events (Phase 2);
 * Phase 1 only emits the durable lifecycle events.
 */
export type RunStreamEvent =
  | { type: 'run.start'; runId: string }
  | {
      type: 'node.start';
      ordinal: number;
      batchId?: number;
      kind: CentraidAutomationRunNode['kind'];
      name?: string;
      args?: unknown;
    }
  | { type: 'node.delta'; ordinal: number; event: unknown }
  | {
      type: 'node.end';
      ordinal: number;
      ok: boolean;
      result?: unknown;
      error?: string;
      durationMs: number;
    }
  | { type: 'run.end'; ok: boolean; error?: string };

/**
 * Subscribe to a run's live events over SSE
 * (`GET /centraid/_automations/run/events?runId=`). The gateway replays the
 * durable ledger snapshot, then streams live until `run.end`. `onEvent` fires
 * per parsed event; the promise resolves when the stream closes. Pass an
 * `AbortSignal` to detach (panel teardown). An abort resolves quietly; other
 * transport failures reject so the caller can fall back to a one-shot read.
 */
export async function streamAutomationRun(
  runId: string,
  onEvent: (ev: RunStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const { baseUrl, token } = await auth();
  try {
    const res = await doFetch(baseUrl, `/centraid/_automations/run/events?runId=${enc(runId)}`, {
      method: 'GET',
      headers: authHeaders(token),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`run events stream failed (HTTP ${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const data = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice('data:'.length).trimStart())
          .join('\n');
        if (!data) continue;
        try {
          const evt = JSON.parse(data) as { type?: string };
          if (evt && typeof evt.type === 'string') onEvent(evt as RunStreamEvent);
        } catch {
          /* skip a malformed frame rather than abort the stream */
        }
      }
    }
  } catch (err) {
    // A caller-initiated abort is a normal teardown, not a failure.
    if (signal.aborted) return;
    throw err;
  }
}

/** Pin / unpin a run as a replay fixture (ledger + central summary). */
export async function pinAutomationRun(input: {
  runId: string;
  pinned: boolean;
}): Promise<{ ok: true }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_automations/run/pin?runId=${enc(input.runId)}`, {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({ pinned: input.pinned }),
  });
  await readJson(res, 'pin run');
  return { ok: true };
}

/** The Insights screen's analytics payload over the central run ledger. */
export async function getInsightsSummary(input?: {
  windowDays?: number;
}): Promise<CentraidInsightsSummary> {
  const { baseUrl, token } = await auth();
  const qs = input?.windowDays !== undefined ? `?windowDays=${enc(String(input.windowDays))}` : '';
  const res = await doFetch(baseUrl, `/centraid/_insights/summary${qs}`, {
    method: 'GET',
    headers: authHeaders(token),
  });
  return readJson<CentraidInsightsSummary>(res, 'insights summary');
}

// ───────────────────────── editing + lifecycle ─────────────────────
// The app-editing (sessions / files / publish) + lifecycle (create / clone
// / meta / automation CRUD) surface lives in `gateway-client-editing.ts`
// (split out for the repo file-size limit). Re-exported here so call sites
// keep importing everything from `./gateway-client.js`.
export * from './gateway-client-editing.js';

// The unified chat transport (SSE turn streaming + chat-history surface)
// lives in `gateway-client-conversation.ts` (issue #141, Phase 3). Re-exported here
// so the chat panel imports it from the same barrel.
export * from './gateway-client-conversation.js';

// The owner consent surface over the mounted vault plane (duaility §12)
// lives in `gateway-client-vault.ts`. Re-exported here so the per-app
// Vault tab imports it from the same barrel.
export * from './gateway-client-vault.js';
