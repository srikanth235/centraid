/*
 * Per-app editing-session manager (issue #137).
 *
 * The desktop no longer owns a local `workspaceDir`; app code lives in
 * the gateway's git store. Editing an app means holding an open git
 * session (a `sessions/<id>` worktree the gateway materialized) and
 * reading/writing draft files into it over HTTP.
 *
 * The renderer's IPC surface is unchanged — it still calls
 * `readAppFiles({ id })` / `writeAppFile({ id, ... })` /
 * `publish({ id })`. This module is the main-process seam that turns
 * those per-app calls into session-scoped HTTP calls: it lazily opens
 * one session per app id, caches it, and reuses it across reads,
 * writes, and the explicit Publish.
 *
 * Session id scheme: `desktop-<appId>` — one stable session per app
 * per launch, so reopening the Code tab reuses the same worktree (and
 * therefore the same in-progress draft). On gateway swap the cache is
 * dropped (`resetAppSessions`) so the next edit opens a session on
 * the new gateway.
 */

import path from 'node:path';
import { openSession, closeSession } from './apps-store-client.js';
import { gatewayCodeStoreDir } from './gateway-paths.js';
import { loadSettings } from './settings.js';

/** appId → open session id (resolves once the open round-trip lands). */
const sessions = new Map<string, Promise<string>>();

/**
 * The desktop's per-app draft-session id scheme. Shared with the gateway's
 * unified chat runner (injected via `serve({ sessionIdFor })`) so the
 * renderer Code tab, the local builder, and gateway chat all edit ONE
 * `desktop-<appId>` worktree. The renderer keeps its own copy of this
 * scheme (`gateway-client-editing.ts`) on purpose — it runs in a separate
 * process and can't import main-process modules.
 */
export function desktopSessionIdFor(appId: string): string {
  return `desktop-${appId}`;
}

/**
 * Get the session id for an app, opening one if needed. Concurrent
 * callers for the same app share the single in-flight open. If the
 * cached open rejected (gateway down mid-edit), it's evicted so the
 * next call retries.
 */
export async function ensureAppSession(appId: string): Promise<string> {
  const existing = sessions.get(appId);
  if (existing) {
    try {
      return await existing;
    } catch {
      sessions.delete(appId);
    }
  }
  const wanted = desktopSessionIdFor(appId);
  // openSession is idempotent on the gateway side only in that a fresh
  // id makes a fresh worktree; a re-open of the SAME id 409s. So we
  // tolerate "already exists" by treating it as success — the worktree
  // is there, which is all the caller needs.
  const p = openSession(wanted).catch((err: unknown) => {
    if (err instanceof Error && /already has a worktree|session_exists/.test(err.message)) {
      return wanted;
    }
    throw err;
  });
  sessions.set(appId, p);
  return p;
}

/**
 * Close + forget an app's session (e.g. on app delete). Idempotent;
 * swallows errors so a delete flow never wedges on a stale session.
 */
export async function dropAppSession(appId: string): Promise<void> {
  const existing = sessions.get(appId);
  sessions.delete(appId);
  let sessionId = desktopSessionIdFor(appId);
  if (existing) {
    try {
      sessionId = await existing;
    } catch {
      return; // never opened; nothing to close
    }
  }
  await closeSession(sessionId).catch(() => undefined);
}

/**
 * Drop every cached session without closing them on the gateway —
 * called on gateway swap, where the old gateway's sessions are moot and
 * the worktrees get GC'd with the gateway. The next edit opens fresh
 * sessions on the new active gateway.
 */
export function resetAppSessions(): void {
  sessions.clear();
}

/**
 * Throw a clear error unless the active gateway is local. The desktop's
 * remaining filesystem-bound operations (issue #141) — APPS_OPEN
 * (reveal-in-Finder) and AGENT_* (the in-process codex/claude builder
 * that writes to the worktree) — only work against the local embedded
 * gateway, which materializes session worktrees on disk. A remote gateway
 * exposes no worktree over the filesystem, so the renderer hides these
 * affordances for remote; this guard is the main-process backstop.
 */
export async function assertActiveGatewayLocal(action: string): Promise<void> {
  const settings = await loadSettings();
  if (settings.activeGatewayKind !== 'local') {
    throw new Error(
      `${action} requires the local gateway (active is ${settings.activeGatewayKind})`,
    );
  }
}

/**
 * Absolute path to the LOCAL session worktree's `apps/<appId>/` dir
 * (opens the session if needed). After issue #141 moved scaffold / clone /
 * automation editing onto the HTTP file-map path, this serves ONLY the two
 * deliberately local-only flows: APPS_OPEN (reveal-in-Finder) and
 * AGENT_* (the in-process builder hands this dir to the codex/claude
 * binary). Requires the active gateway to be local — remote gateways don't
 * expose their worktrees over the filesystem.
 *
 * Caller must ensure the dir exists (the agent creates it as a side effect
 * of writing into it).
 */
export async function ensureAppSessionDir(appId: string): Promise<string> {
  await assertActiveGatewayLocal(`editing app "${appId}"`);
  const settings = await loadSettings();
  const sessionId = await ensureAppSession(appId);
  return path.join(
    gatewayCodeStoreDir(settings.activeGatewayId),
    'worktrees',
    'sessions',
    sessionId,
    'apps',
    appId,
  );
}
