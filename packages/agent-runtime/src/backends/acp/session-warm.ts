/*
 * Optional warm ACP process pool — reuse a still-live agent process across
 * sequential turns that share kind + cwd + sessionId.
 *
 * Each chat turn used to spawn and kill an agent, so multi-turn latency and
 * session/load effectiveness suffered. When a turn ends cleanly we keep the
 * child for a short idle window; the next turn with the same session id can
 * skip spawn + initialize and reattach via session/resume (or load).
 *
 * Vault MCP is still per-turn (fresh ToolContext); only the agent process is
 * reused. Concurrent turns never share a slot.
 */

import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { AcpConnection } from './json-rpc.js';

const IDLE_MS = 120_000;

export interface WarmAgentSlot {
  key: string;
  kind: string;
  cwd: string;
  sessionId: string;
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  conn: AcpConnection;
  canResume: boolean;
  canLoad: boolean;
  canClose: boolean;
  /** Agent still has HTTP MCP capability from the original initialize. */
  httpMcp: boolean;
  promptCaps: Record<string, unknown>;
  lastUsed: number;
  timer: ReturnType<typeof setTimeout>;
}

const pool = new Map<string, WarmAgentSlot>();

export function warmKey(kind: string, cwd: string, sessionId: string): string {
  return `${kind}\0${cwd}\0${sessionId}`;
}

export function takeWarmSlot(
  kind: string,
  cwd: string,
  sessionId: string,
): WarmAgentSlot | undefined {
  const key = warmKey(kind, cwd, sessionId);
  const slot = pool.get(key);
  if (!slot) return undefined;
  pool.delete(key);
  clearTimeout(slot.timer);
  if (slot.conn.hasExited() || slot.child.killed) {
    void disposeSlot(slot);
    return undefined;
  }
  slot.lastUsed = Date.now();
  return slot;
}

export function putWarmSlot(slot: Omit<WarmAgentSlot, 'timer' | 'key' | 'lastUsed'>): void {
  const key = warmKey(slot.kind, slot.cwd, slot.sessionId);
  // Replace any stale entry for this session.
  const prev = pool.get(key);
  if (prev) {
    pool.delete(key);
    clearTimeout(prev.timer);
    void disposeSlot(prev);
  }
  const entry: WarmAgentSlot = {
    ...slot,
    key,
    lastUsed: Date.now(),
    timer: setTimeout(() => {
      const cur = pool.get(key);
      if (cur) {
        pool.delete(key);
        void disposeSlot(cur);
      }
    }, IDLE_MS),
  };
  // Don't keep the event loop alive solely for idle eviction.
  entry.timer.unref?.();
  pool.set(key, entry);
}

export async function disposeSlot(
  slot: WarmAgentSlot | Omit<WarmAgentSlot, 'timer' | 'key' | 'lastUsed'>,
): Promise<void> {
  const conn = slot.conn;
  const child = slot.child;
  if ('canClose' in slot && slot.canClose && !conn.hasExited()) {
    try {
      await conn.request('session/close', { sessionId: slot.sessionId });
    } catch {
      // ignore — kill path follows
    }
  }
  try {
    child.stdin.end();
  } catch {
    // ignore
  }
  if (!child.killed) child.kill('SIGTERM');
  await conn.exited.catch(() => undefined);
}

/** Test helper: drop every warm slot. */
export async function clearWarmPool(): Promise<void> {
  const all = [...pool.values()];
  pool.clear();
  for (const s of all) {
    clearTimeout(s.timer);
    await disposeSlot(s);
  }
}
