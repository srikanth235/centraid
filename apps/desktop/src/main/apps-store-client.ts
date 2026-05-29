/*
 * HTTP client for the gateway's git-store editing + publish surface
 * (issue #137), exposed under `/centraid/_apps`. Replaces the desktop's
 * direct `workspaceDir` reads/writes + tarball publish: the gateway now
 * owns drafted code as a git store, so the desktop is a thin client
 * that opens a session, writes draft files into the session worktree,
 * and publishes — all over HTTP against the active gateway (local or
 * remote, identical wire protocol).
 *
 * Same thin-client + cached-auth shape as `user-prefs-client.ts`.
 * `resetAppsStoreAuthCache()` is called from settings-save when the
 * gateway URL/token may have flipped.
 */

import { loadSettings } from './settings.js';
import type {
  AutomationRow,
  AutomationRunRow,
  AutomationRunNodeRow,
  InsightsSummary,
  ListAutomationProjectsResult,
} from '@centraid/runtime-core';

interface AuthCache {
  baseUrl: string;
  token: string | undefined;
}
let cachedAuth: AuthCache | undefined;
let inflightAuth: Promise<AuthCache> | undefined;

async function auth(): Promise<AuthCache> {
  if (cachedAuth) return cachedAuth;
  if (!inflightAuth) {
    inflightAuth = (async () => {
      const settings = await loadSettings();
      const next: AuthCache = {
        baseUrl: settings.gatewayUrl.replace(/\/$/, ''),
        token: settings.gatewayToken || undefined,
      };
      cachedAuth = next;
      return next;
    })().finally(() => {
      inflightAuth = undefined;
    });
  }
  return inflightAuth;
}

export function resetAppsStoreAuthCache(): void {
  cachedAuth = undefined;
}

function headers(token: string | undefined, contentType?: string): Record<string, string> {
  const h: Record<string, string> = {};
  if (token) h.authorization = `Bearer ${token}`;
  if (contentType) h['content-type'] = contentType;
  return h;
}

async function parse<T>(res: Response, label: string): Promise<T> {
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const msg =
      parsed && typeof parsed === 'object' && 'message' in parsed
        ? String((parsed as { message: unknown }).message)
        : `${label} HTTP ${res.status}`;
    throw new Error(msg);
  }
  return parsed as T;
}

export interface DraftFile {
  path: string;
  content: string;
}

/** Open (or reuse) an editing session; returns the session id. */
export async function openSession(sessionId?: string): Promise<string> {
  const { baseUrl, token } = await auth();
  const res = await fetch(`${baseUrl}/centraid/_apps/_sessions`, {
    method: 'POST',
    headers: headers(token, 'application/json'),
    body: JSON.stringify(sessionId ? { sessionId } : {}),
  });
  const out = await parse<{ sessionId: string }>(res, 'open-session');
  return out.sessionId;
}

/** Close a session and discard its worktree. */
export async function closeSession(sessionId: string): Promise<void> {
  const { baseUrl, token } = await auth();
  const res = await fetch(`${baseUrl}/centraid/_apps/_sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    headers: headers(token),
  });
  await parse(res, 'close-session');
}

/** Read all draft files for an app inside a session worktree. */
export async function readDraftFiles(sessionId: string, appId: string): Promise<DraftFile[]> {
  const { baseUrl, token } = await auth();
  const res = await fetch(
    `${baseUrl}/centraid/_apps/${encodeURIComponent(appId)}/files?sessionId=${encodeURIComponent(sessionId)}`,
    { headers: headers(token) },
  );
  const out = await parse<{ files: DraftFile[] }>(res, 'read-files');
  return out.files ?? [];
}

/** Write a single draft file into a session worktree. */
export async function writeDraftFile(
  sessionId: string,
  appId: string,
  relPath: string,
  content: string,
): Promise<{ path: string; size: number }> {
  const { baseUrl, token } = await auth();
  const rel = relPath
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
  const res = await fetch(
    `${baseUrl}/centraid/_apps/${encodeURIComponent(appId)}/files/${rel}?sessionId=${encodeURIComponent(sessionId)}`,
    { method: 'PUT', headers: headers(token, 'text/plain'), body: content },
  );
  return parse(res, 'write-file');
}

/**
 * Write a batch of draft files into a session worktree (issue #141).
 * Sequential PUTs over the single-file route — the scaffold/clone/meta
 * flows produce a handful of files, so a dedicated batch route isn't
 * worth it yet. Used by the HTTP scaffold/clone path so app creation
 * works against a remote gateway (no local worktree write).
 */
export async function writeDraftFiles(
  sessionId: string,
  appId: string,
  files: ReadonlyArray<DraftFile>,
): Promise<void> {
  for (const f of files) {
    await writeDraftFile(sessionId, appId, f.path, f.content);
  }
}

/** Delete a single draft file from a session worktree (issue #141). */
export async function deleteDraftFile(
  sessionId: string,
  appId: string,
  relPath: string,
): Promise<void> {
  const { baseUrl, token } = await auth();
  const rel = relPath
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
  const res = await fetch(
    `${baseUrl}/centraid/_apps/${encodeURIComponent(appId)}/files/${rel}?sessionId=${encodeURIComponent(sessionId)}`,
    { method: 'DELETE', headers: headers(token) },
  );
  await parse(res, 'delete-file');
}

/**
 * Delete a batch of draft files from a session worktree (issue #141).
 * Sequential DELETEs over the single-file route — used by the HTTP
 * app-owned-automation delete path so it works against a remote gateway.
 */
export async function deleteDraftFiles(
  sessionId: string,
  appId: string,
  relPaths: ReadonlyArray<string>,
): Promise<void> {
  for (const rel of relPaths) {
    await deleteDraftFile(sessionId, appId, rel);
  }
}

export interface PublishResult {
  id: string;
  versionTag: string;
  sha: string;
}

/** Publish a session's edits to one app (explicit commit message). */
export async function publishApp(
  sessionId: string,
  appId: string,
  message: string,
): Promise<PublishResult> {
  const { baseUrl, token } = await auth();
  const res = await fetch(`${baseUrl}/centraid/_apps/${encodeURIComponent(appId)}/publish`, {
    method: 'POST',
    headers: headers(token, 'application/json'),
    body: JSON.stringify({ sessionId, message }),
  });
  return parse(res, 'publish');
}

/** Forward-only rollback to an existing version tag. */
export async function rollbackApp(
  appId: string,
  versionTag: string,
): Promise<{ id: string; sha: string }> {
  const { baseUrl, token } = await auth();
  const res = await fetch(`${baseUrl}/centraid/_apps/${encodeURIComponent(appId)}/rollback`, {
    method: 'POST',
    headers: headers(token, 'application/json'),
    body: JSON.stringify({ versionTag }),
  });
  return parse(res, 'rollback');
}

export interface AppMetaRow {
  id: string;
  name?: string;
  description?: string;
  /**
   * App classification from `app.json#kind`: `'automation'` marks a UI-less
   * automation app, `'app'` / undefined a normal UI app. Replaces the legacy
   * `auto.` id-prefix convention as the automation signal.
   */
  kind?: 'app' | 'automation';
  hasIndex: boolean;
}

/** Apps on main + their metadata. Replaces legacy `listProjects(workspaceDir)`. */
export async function listAppsWithMeta(): Promise<AppMetaRow[]> {
  const { baseUrl, token } = await auth();
  const res = await fetch(`${baseUrl}/centraid/_apps`, { headers: headers(token) });
  const out = await parse<AppMetaRow[]>(res, 'list-apps');
  return out ?? [];
}

/** Remove an app from main (forward commit, tags reaped). */
export async function deleteApp(appId: string): Promise<void> {
  const { baseUrl, token } = await auth();
  const res = await fetch(`${baseUrl}/centraid/_apps/${encodeURIComponent(appId)}`, {
    method: 'DELETE',
    headers: headers(token),
  });
  await parse(res, 'delete-app');
}

export interface GitVersion {
  tag: string;
  version: number;
  sha: string;
  uploadedAt: string;
  /** `true` iff this tag's subtree matches the one currently on main. */
  active: boolean;
}

/** Tag-driven version history for the app, newest-first. */
export async function listGitVersions(appId: string): Promise<GitVersion[]> {
  const { baseUrl, token } = await auth();
  const res = await fetch(`${baseUrl}/centraid/_apps/${encodeURIComponent(appId)}/git-versions`, {
    headers: headers(token),
  });
  const out = await parse<{ versions: GitVersion[] }>(res, 'git-versions');
  return out.versions ?? [];
}

// ---- Automation runtime ops (issue #141) ----
// Proxy the gateway's `/centraid/_automations` + `/centraid/_insights`
// routes over the same active gateway + cached auth as the git-store
// surface above, so the desktop reads/runs automations + analytics against
// local AND remote gateways. Code (manifests) resolves gateway-side from
// the materialized `main`; run ledgers + analytics from the gateway's data
// dir. A run-now fires on the gateway host with ITS runner config — the
// desktop's provider key is not used for a remote fire.

/** All automations on `main` plus per-app read errors. */
export async function listAutomationsHttp(): Promise<ListAutomationProjectsResult> {
  const { baseUrl, token } = await auth();
  const res = await fetch(`${baseUrl}/centraid/_automations`, { headers: headers(token) });
  return parse(res, 'list-automations');
}

/** One automation by its `<appId>/<id>` ref, or null when absent. */
export async function readAutomationHttp(ref: string): Promise<AutomationRow | null> {
  const { baseUrl, token } = await auth();
  const res = await fetch(`${baseUrl}/centraid/_automations/read?ref=${encodeURIComponent(ref)}`, {
    headers: headers(token),
  });
  const out = await parse<{ row: AutomationRow | null }>(res, 'read-automation');
  return out.row ?? null;
}

/** Fire an automation now on the gateway host; returns the minted run id. */
export async function runAutomationNow(ref: string): Promise<{ runId: string }> {
  const { baseUrl, token } = await auth();
  const res = await fetch(
    `${baseUrl}/centraid/_automations/run-now?ref=${encodeURIComponent(ref)}`,
    { method: 'POST', headers: headers(token) },
  );
  return parse(res, 'run-now');
}

/** Central run-summary feed, newest-first. `ref` scopes to one automation. */
export async function listAutomationRunsHttp(
  ref: string | undefined,
  limit: number,
): Promise<AutomationRunRow[]> {
  const { baseUrl, token } = await auth();
  const qs = new URLSearchParams();
  if (ref) qs.set('ref', ref);
  qs.set('limit', String(limit));
  const res = await fetch(`${baseUrl}/centraid/_automations/runs?${qs.toString()}`, {
    headers: headers(token),
  });
  const out = await parse<{ runs: AutomationRunRow[] }>(res, 'list-runs');
  return out.runs ?? [];
}

/** One run's full record from its app's ledger, or null when unknown. */
export async function readAutomationRunHttp(runId: string): Promise<AutomationRunRow | null> {
  const { baseUrl, token } = await auth();
  const res = await fetch(
    `${baseUrl}/centraid/_automations/run?runId=${encodeURIComponent(runId)}`,
    { headers: headers(token) },
  );
  const out = await parse<{ run: AutomationRunRow | null }>(res, 'read-run');
  return out.run ?? null;
}

/** The run's node timeline from its app's ledger. */
export async function listAutomationRunNodesHttp(runId: string): Promise<AutomationRunNodeRow[]> {
  const { baseUrl, token } = await auth();
  const res = await fetch(
    `${baseUrl}/centraid/_automations/run/nodes?runId=${encodeURIComponent(runId)}`,
    { headers: headers(token) },
  );
  const out = await parse<{ nodes: AutomationRunNodeRow[] }>(res, 'run-nodes');
  return out.nodes ?? [];
}

/** Pin / unpin a run as a replay fixture (ledger + central summary). */
export async function pinAutomationRunHttp(runId: string, pinned: boolean): Promise<void> {
  const { baseUrl, token } = await auth();
  const res = await fetch(
    `${baseUrl}/centraid/_automations/run/pin?runId=${encodeURIComponent(runId)}`,
    {
      method: 'POST',
      headers: headers(token, 'application/json'),
      body: JSON.stringify({ pinned }),
    },
  );
  await parse(res, 'pin-run');
}

/** The Insights screen's analytics payload over the central run ledger. */
export async function insightsSummaryHttp(windowDays?: number): Promise<InsightsSummary> {
  const { baseUrl, token } = await auth();
  const qs =
    windowDays !== undefined ? `?windowDays=${encodeURIComponent(String(windowDays))}` : '';
  const res = await fetch(`${baseUrl}/centraid/_insights/summary${qs}`, {
    headers: headers(token),
  });
  return parse(res, 'insights-summary');
}
