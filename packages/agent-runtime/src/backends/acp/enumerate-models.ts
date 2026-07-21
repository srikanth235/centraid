/*
 * Generic ACP model enumeration — the ONE way every runner kind reports its
 * model catalog (issue #484).
 *
 * There is no bespoke claude/codex enumerator any more. ACP already carries
 * the answer: an agent advertises its model selector as a `configOptions`
 * entry on the `session/new` RESULT (see `./session-config.ts`), the same
 * option `pinModel` reads to switch models mid-turn. So enumeration is just a
 * probe: launch the agent exactly as a turn would, `initialize`, open a fresh
 * session in a scratch cwd, read the offered models off the returned config
 * option, then tear the process down. No prompt is ever sent — no model turn,
 * no tokens.
 *
 * This never fabricates a catalog: it only echoes the `{ value, name }` pairs
 * the agent itself offered, so the `no-hardcoded-model-ids` rule holds without
 * this file naming a single concrete model id.
 *
 * Best-effort by contract (the `CatalogWarmer` treats an empty result as "keep
 * the prior entry"): ANY failure — no binary, adapter not installed,
 * `AUTH_REQUIRED` (-32000) from an unsigned-in agent, a probe that outruns the
 * deadline, or an agent with no model option — resolves to `[]`. It never
 * throws, and it never leaves the child process running (the `finally` ends
 * stdin, sends SIGTERM, then SIGKILLs if the child ignores it).
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { RunnerModel } from '@centraid/app-engine';
import { lowPriorityCommand } from '../../low-priority.js';
import { ACP_PROTOCOL_VERSION, createAcpConnection } from './json-rpc.js';
import { planLaunch } from './launch.js';
import {
  readConfigOptions,
  readOfferedModels,
  type InitializeResult,
  type OfferedModel,
  type SessionSetupResult,
} from './session-config.js';
import type { AcpTurnConfig } from './types.js';

/**
 * Overall probe deadline. Generous — enumeration runs only through the
 * `CatalogWarmer` (boot + Refresh), never on a hot path — but bounded so a
 * wedged agent can't leave the warm hanging. Covers spawn → initialize →
 * session/new → teardown end to end.
 */
const PROBE_TIMEOUT_MS = 12_000;

/** How long to wait after SIGTERM before SIGKILL, so a stuck child is always reaped. */
const KILL_GRACE_MS = 2_000;

/**
 * Enumerate the models an ACP agent advertises, launched exactly as its turns
 * are (same `planLaunch` → same adapter/env/binPath). Returns `[]` on any
 * failure; never throws; never leaves a child running.
 */
export async function enumerateAcpModels(config: AcpTurnConfig): Promise<RunnerModel[]> {
  // Launch is impossible with no binary (or a missing adapter) — `planLaunch`
  // throws, and an unenumerable kind simply has no catalog. Notices are
  // irrelevant here (no transcript), so they are collected and dropped.
  let launch: { bin: string; args: string[]; env: NodeJS.ProcessEnv };
  try {
    launch = planLaunch(config, undefined, []);
  } catch {
    return [];
  }

  let cwd: string;
  try {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-acp-models-'));
  } catch {
    return [];
  }

  let child: ChildProcessByStdio<Writable, Readable, Readable>;
  try {
    const command = lowPriorityCommand(launch.bin, launch.args);
    child = spawn(command.bin, command.args, {
      cwd,
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessByStdio<Writable, Readable, Readable>;
  } catch {
    await removeQuietly(cwd);
    return [];
  }

  const conn = createAcpConnection(child, {
    // We advertise no client capabilities during a probe, so decline any
    // server→client request (fs/terminal/permission) politely.
    onServerRequest: (id, method) => conn.respondMethodNotFound(id, method),
    // A `session/load` we never issue can't fire; a stray `session/update`
    // (some agents greet a fresh session) is irrelevant to enumeration.
    onNotification: () => undefined,
  });

  try {
    return await withTimeout(probe(conn, cwd), PROBE_TIMEOUT_MS);
  } catch {
    // Timeout, AUTH_REQUIRED (-32000), a rejected session/new, an exited
    // child — all are "no catalog this time".
    return [];
  } finally {
    try {
      child.stdin.end();
    } catch {
      // stream already gone
    }
    if (!child.killed) child.kill('SIGTERM');
    // A child that ignores SIGTERM must still die, or `conn.exited` (and thus
    // this warm) would hang forever.
    const killTimer = setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, KILL_GRACE_MS);
    killTimer.unref?.();
    await conn.exited;
    clearTimeout(killTimer);
    await removeQuietly(cwd);
  }
}

/**
 * Drive the minimal enumeration exchange: handshake, then a fresh session
 * whose result carries the model config option. Rejects on any RPC failure
 * (including `AUTH_REQUIRED`), which the caller maps to `[]`.
 */
async function probe(
  conn: ReturnType<typeof createAcpConnection>,
  cwd: string,
): Promise<RunnerModel[]> {
  await conn.request<InitializeResult>('initialize', {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'centraid-local-runner', title: 'Centraid', version: '0.1.0' },
  });

  // No vault MCP servers: enumeration reads the agent's own catalog, not the
  // vault. The scratch cwd is a throwaway the agent never writes to.
  const created = await conn.request<SessionSetupResult>('session/new', {
    cwd,
    mcpServers: [],
  });

  const { models, currentValue } = readOfferedModels(readConfigOptions(created));
  return mapOfferedModels(models, currentValue);
}

/**
 * Map the agent's offered `{ value, name }` pairs to `RunnerModel[]`: `value`
 * → `id`, `name` → label (dropped when it merely echoes the id), and the
 * option's `currentValue` flagged as the default selection. Dedupes by id and
 * drops blanks. Exported for tests.
 */
export function mapOfferedModels(offered: OfferedModel[], currentValue?: string): RunnerModel[] {
  const seen = new Set<string>();
  const models: RunnerModel[] = [];
  for (const entry of offered) {
    const id = entry.value.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const model: RunnerModel = { id };
    const name = entry.name?.trim();
    if (name && name !== id) model.name = name;
    if (currentValue && id === currentValue) model.default = true;
    models.push(model);
  }
  return models;
}

/** Reject `work` if it outruns `ms`; the caller's `finally` reaps the child. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('acp model probe timed out')), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function removeQuietly(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
