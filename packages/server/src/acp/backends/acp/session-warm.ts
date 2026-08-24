/*
 * Optional warm ACP process pool — reuse a still-live harness process across
 * sequential turns that share kind + cwd + sessionId.
 *
 * Spawning and killing a harness on every conversation turn costs multi-turn
 * latency and session/load effectiveness. When a turn ends cleanly we keep the
 * child for a short idle window; the next turn with the same session id can
 * skip spawn + initialize and reattach via session/resume (or load).
 *
 * Vault MCP is still per-turn (fresh ToolContext); only the harness process is
 * reused. Concurrent turns never share a slot.
 */

import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import { methods } from "@agentclientprotocol/sdk";
import type { PromptCapabilities } from "@agentclientprotocol/sdk";

import type { AcpConnectionOwner } from "./connection.js";

const IDLE_MS = 120_000;
const MAX_WARM_SLOTS = 8;
const DISPOSE_TIMEOUT_MS = 5_000;

async function bounded<T>(promise: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), DISPOSE_TIMEOUT_MS);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export interface WarmHarnessSlot {
  key: string;
  kind: string;
  /** Stable ledger identity; unlike cwd, this does not alias other threads. */
  conversationId?: string;
  cwd: string;
  sessionId: string;
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  conn: AcpConnectionOwner;
  canResume: boolean;
  canLoad: boolean;
  canClose: boolean;
  canAdditional: boolean;
  /** Harness still has HTTP MCP capability from the original initialize. */
  httpMcp: boolean;
  promptCaps: PromptCapabilities;
  lastUsed: number;
  timer: ReturnType<typeof setTimeout>;
}

const pool = new Map<string, WarmHarnessSlot>();

export function warmKey(
  kind: string,
  cwd: string,
  sessionId: string,
  conversationId = sessionId
): string {
  return `${conversationId}\0${kind}\0${cwd}\0${sessionId}`;
}

export function takeWarmSlot(
  kind: string,
  cwd: string,
  sessionId: string,
  conversationId?: string
): WarmHarnessSlot | undefined {
  const key = warmKey(kind, cwd, sessionId, conversationId);
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

export function putWarmSlot(
  slot: Omit<WarmHarnessSlot, "timer" | "key" | "lastUsed">
): void {
  const conversationId = slot.conversationId ?? slot.sessionId;
  const key = warmKey(slot.kind, slot.cwd, slot.sessionId, conversationId);
  // A conversation keeps exactly one warm process. cwd is not an identity:
  // unrelated conversations can legitimately share the same workspace.
  for (const [existingKey, existing] of pool) {
    if (
      existingKey === key ||
      (existing.conversationId ?? existing.sessionId) !== conversationId
    )
      continue;
    pool.delete(existingKey);
    clearTimeout(existing.timer);
    void disposeSlot(existing);
  }
  // Replace any stale entry for this session.
  const prev = pool.get(key);
  if (prev) {
    pool.delete(key);
    clearTimeout(prev.timer);
    void disposeSlot(prev);
  }
  const entry: WarmHarnessSlot = {
    ...slot,
    conversationId,
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
  if (pool.size > MAX_WARM_SLOTS) {
    const oldest = [...pool.values()]
      .filter((candidate) => candidate.key !== key)
      .sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (oldest) {
      pool.delete(oldest.key);
      clearTimeout(oldest.timer);
      void disposeSlot(oldest);
    }
  }
}

export async function disposeSlot(
  slot: WarmHarnessSlot | Omit<WarmHarnessSlot, "timer" | "key" | "lastUsed">
): Promise<void> {
  const conn = slot.conn;
  const child = slot.child;
  if ("canClose" in slot && slot.canClose && !conn.hasExited()) {
    try {
      await bounded(
        conn.request(methods.agent.session.close, {
          sessionId: slot.sessionId,
        })
      );
    } catch {
      // ignore — kill path follows
    }
  }
  try {
    child.stdin.end();
  } catch {
    // ignore
  }
  if (!child.killed) child.kill("SIGTERM");
  const exited = await bounded(
    conn.exited.then(
      () => true,
      () => true
    )
  );
  if (!exited) {
    // SIGTERM is a request. A harness that ignores it would leak one warm
    // child per evicted slot, so the dispose path escalates.
    child.kill("SIGKILL");
    await conn.exited.catch(() => undefined);
  }
}

/** Test helper: drop every warm slot. */
export async function clearWarmPool(): Promise<void> {
  const all = [...pool.values()];
  pool.clear();
  await Promise.all(
    all.map(async (slot) => {
      clearTimeout(slot.timer);
      await disposeSlot(slot);
    })
  );
}
