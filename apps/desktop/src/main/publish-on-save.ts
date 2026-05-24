// Workspace → gateway publish queue.
//
// Issue #108. The desktop's workspaceDir holds editable source; the
// gateway's appsDir holds versioned uploads. To keep them in sync without
// asking the user to click Publish after every edit, every workspace write
// (scaffold, agent file write, user keystroke save) calls `requestPublish`.
//
// Behaviour:
//   - Per-project debounce window collapses bursts of writes into one
//     upload (the agent rewriting ten handlers per turn produces ONE new
//     version, not ten).
//   - If a publish is in-flight when a new request arrives, the entry is
//     flagged `retriggered` and a follow-up publish fires on completion.
//   - Failures are kept on the entry (`lastError`) and broadcast to every
//     BrowserWindow via `Channel.PUBLISH_EVENT` so the renderer can toast.
//
// The publish itself goes through `publishProject` (same code path as the
// explicit Publish button), so the local and remote gateways accept
// identical input.

import path from 'node:path';
import { BrowserWindow } from 'electron';
import { loadSettings } from './settings.js';

/** IPC channel for renderer subscriptions. Mirrored in preload + d.ts. */
export const PUBLISH_EVENT_CHANNEL = 'centraid:publish:event';

const DEFAULT_DEBOUNCE_MS = 500;

interface PendingEntry {
  timer?: NodeJS.Timeout;
  inFlight: boolean;
  retriggered: boolean;
  lastError?: string;
  lastPublishedAt?: number;
}

const pending = new Map<string, PendingEntry>();

export interface RequestPublishOptions {
  /** Override the debounce window. Default 500ms. */
  debounceMs?: number;
  /** Fire on the next tick (used right after scaffold). */
  immediate?: boolean;
}

export interface PublishEvent {
  id: string;
  ok: boolean;
  error?: string;
  publishedAt?: number;
}

export interface PublishStatus {
  inFlight: boolean;
  lastError?: string;
  lastPublishedAt?: number;
}

/** Read-only snapshot of the queue state for project `id`. */
export function getPublishStatus(id: string): PublishStatus {
  const e = pending.get(id);
  if (!e) return { inFlight: false };
  return {
    inFlight: e.inFlight,
    ...(e.lastError !== undefined ? { lastError: e.lastError } : {}),
    ...(e.lastPublishedAt !== undefined ? { lastPublishedAt: e.lastPublishedAt } : {}),
  };
}

/**
 * Queue a publish for `id`. Multiple calls within the debounce window
 * collapse to one upload. Safe to call from any IPC handler that just
 * mutated `workspaceDir/<id>/`.
 */
export function requestPublish(id: string, opts: RequestPublishOptions = {}): void {
  let entry = pending.get(id);
  if (!entry) {
    entry = { inFlight: false, retriggered: false };
    pending.set(id, entry);
  }
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = undefined;
  }
  if (entry.inFlight) {
    entry.retriggered = true;
    return;
  }
  const delay = opts.immediate ? 0 : (opts.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  entry.timer = setTimeout(() => {
    void runPublish(id);
  }, delay);
}

/**
 * Cancel any pending publish for `id` and forget the entry. Called when
 * a project is deleted so a queued upload doesn't recreate it on the
 * gateway after deregister.
 */
export function forgetPublish(id: string): void {
  const entry = pending.get(id);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  pending.delete(id);
}

async function runPublish(id: string): Promise<void> {
  const entry = pending.get(id);
  if (!entry) return;
  entry.timer = undefined;
  entry.inFlight = true;
  entry.retriggered = false;
  let event: PublishEvent;
  try {
    const settings = await loadSettings();
    const projectDir = path.join(settings.workspaceDir, id);
    const { publishProject } = await import('@centraid/builder-harness');
    // skipBuild — the workspace IS the source of truth; we don't run a
    // bundler before each save. Handlers ship as-authored.
    await publishProject(projectDir, id, settings, { skipBuild: true });
    entry.lastError = undefined;
    entry.lastPublishedAt = Date.now();
    event = { id, ok: true, publishedAt: entry.lastPublishedAt };
  } catch (err) {
    entry.lastError = err instanceof Error ? err.message : String(err);
    console.warn(`[publish-on-save] ${id}: ${entry.lastError}`);
    event = { id, ok: false, error: entry.lastError };
  } finally {
    entry.inFlight = false;
  }
  broadcast(event);
  if (entry.retriggered) {
    entry.retriggered = false;
    requestPublish(id);
  }
}

function broadcast(event: PublishEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(PUBLISH_EVENT_CHANNEL, event);
  }
}
