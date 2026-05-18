/*
 * Per-app chat transcript storage.
 *
 * Layout (extends the existing per-app folder):
 *
 *   <appsDir>/<appId>/
 *     _chat/
 *       w<windowId>.jsonl    ← runner-owned transcript (pi session file,
 *                              codex thread blob, or our own JSONL)
 *       index.json           ← { windows: [{ id, mode, ... }] }
 *
 * `index.json` is the runtime's view: which windows exist, what mode each
 * is pinned to, and per-adapter session-id metadata. The actual transcript
 * format is up to the runner. The on-disk index is read+rewritten atomically
 * (tmpfile + rename) on every mutation — concurrent writers are serialized
 * by the per-window async lock in `chat-routes.ts`.
 *
 * Window ids are caller-supplied strings (the renderer mints a stable id
 * per chat pane). We do not validate them beyond banning path separators
 * so a malicious id can't escape `_chat/`.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { ChatMode } from './chat-runner.js';

export const CHAT_DIR_NAME = '_chat';
export const CHAT_INDEX_FILE = 'index.json';

export interface ChatWindowMeta {
  id: string;
  mode: ChatMode;
  createdAt: number;
  lastMessageAt: number;
  turnCount: number;
  /**
   * Per-adapter resumable session id. Opaque to the route handler;
   * meaningful only to the runner that wrote it (codex thread id,
   * claude-code session id, OpenClaw session key, ...).
   */
  adapterSessionId?: string;
  /** Adapter kind that owns `adapterSessionId`. Used to invalidate when the
   *  user switches runners (mid-window kind change starts a new session). */
  adapterKind?: string;
}

export interface ChatIndex {
  windows: ChatWindowMeta[];
}

function emptyIndex(): ChatIndex {
  return { windows: [] };
}

/**
 * Validate a window id. Reject anything that could escape the `_chat/`
 * subdirectory or collide with the index file.
 */
export function isValidWindowId(id: string): boolean {
  if (!id || id.length > 128) return false;
  if (id === CHAT_INDEX_FILE) return false;
  if (id.startsWith('.')) return false;
  return /^[A-Za-z0-9_\-:]+$/.test(id);
}

export function chatDir(appDir: string): string {
  return path.join(appDir, CHAT_DIR_NAME);
}

export function chatIndexPath(appDir: string): string {
  return path.join(chatDir(appDir), CHAT_INDEX_FILE);
}

export function chatSessionFile(appDir: string, windowId: string): string {
  return path.join(chatDir(appDir), `w${windowId}.jsonl`);
}

export class ChatStore {
  constructor(private readonly appDir: string) {}

  /**
   * Read the per-app chat index. Returns an empty index when the file
   * doesn't exist yet (a never-used chat is normal — no need to materialize
   * the directory until the first POST).
   */
  async readIndex(): Promise<ChatIndex> {
    try {
      const raw = await fs.readFile(chatIndexPath(this.appDir), 'utf8');
      const parsed = JSON.parse(raw) as ChatIndex;
      if (!Array.isArray(parsed.windows)) return emptyIndex();
      return parsed;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyIndex();
      throw err;
    }
  }

  /** Atomic write — same tmpfile + rename pattern as `_registry.json`. */
  private async writeIndex(index: ChatIndex): Promise<void> {
    const dir = chatDir(this.appDir);
    await fs.mkdir(dir, { recursive: true });
    const file = chatIndexPath(this.appDir);
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(index, null, 2), { mode: 0o600 });
    await fs.rename(tmp, file);
  }

  async listWindows(): Promise<ChatWindowMeta[]> {
    const idx = await this.readIndex();
    return idx.windows.slice().sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  }

  async getWindow(windowId: string): Promise<ChatWindowMeta | undefined> {
    const idx = await this.readIndex();
    return idx.windows.find((w) => w.id === windowId);
  }

  /**
   * Ensure the window exists in the index. Returns the stored meta (whether
   * it pre-existed or was just created). If a window's first turn requested
   * a different mode than what's pinned, the existing mode wins — once a
   * window is established, subsequent turns inherit it. Callers that want
   * to start a new mode should pick a new windowId.
   */
  async upsertWindow(
    windowId: string,
    desiredMode: ChatMode,
    adapter?: { kind: string; sessionId?: string },
  ): Promise<ChatWindowMeta> {
    if (!isValidWindowId(windowId)) {
      throw new Error(`invalid window id "${windowId}"`);
    }
    const idx = await this.readIndex();
    const existing = idx.windows.find((w) => w.id === windowId);
    const now = Date.now();
    if (existing) {
      if (adapter && (adapter.kind !== existing.adapterKind || !existing.adapterSessionId)) {
        // Adapter switched mid-window — drop the stale resume id.
        existing.adapterKind = adapter.kind;
        existing.adapterSessionId = adapter.sessionId;
        existing.lastMessageAt = now;
        await this.writeIndex(idx);
      }
      return existing;
    }
    const fresh: ChatWindowMeta = {
      id: windowId,
      mode: desiredMode,
      createdAt: now,
      lastMessageAt: now,
      turnCount: 0,
      adapterKind: adapter?.kind,
      adapterSessionId: adapter?.sessionId,
    };
    idx.windows.push(fresh);
    await this.writeIndex(idx);
    return fresh;
  }

  /** Record turn completion. Bumps `turnCount` + `lastMessageAt`. */
  async noteTurn(windowId: string, adapter?: { kind: string; sessionId?: string }): Promise<void> {
    const idx = await this.readIndex();
    const w = idx.windows.find((x) => x.id === windowId);
    if (!w) return;
    w.turnCount += 1;
    w.lastMessageAt = Date.now();
    if (adapter) {
      w.adapterKind = adapter.kind;
      if (adapter.sessionId) w.adapterSessionId = adapter.sessionId;
    }
    await this.writeIndex(idx);
  }

  async deleteWindow(windowId: string): Promise<boolean> {
    const idx = await this.readIndex();
    const before = idx.windows.length;
    idx.windows = idx.windows.filter((w) => w.id !== windowId);
    if (idx.windows.length === before) return false;
    await this.writeIndex(idx);
    // Best-effort transcript cleanup. We don't propagate ENOENT — a window
    // with no transcript is still a valid delete.
    const file = chatSessionFile(this.appDir, windowId);
    await fs.unlink(file).catch(() => undefined);
    return true;
  }

  /**
   * Replay the persisted transcript for one window. Each JSONL line is
   * parsed individually; bad lines are skipped (defensive — runners we
   * don't control might prepend whitespace or comments). Returns an empty
   * array when the file doesn't exist (yet) or the window has no entries.
   */
  async readTranscript(windowId: string): Promise<unknown[]> {
    if (!isValidWindowId(windowId)) {
      throw new Error(`invalid window id "${windowId}"`);
    }
    const file = chatSessionFile(this.appDir, windowId);
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const entries: unknown[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
        // ignore — runner-owned format may include comment lines etc.
      }
    }
    return entries;
  }
}
