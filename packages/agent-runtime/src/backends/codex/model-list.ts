/*
 * Codex model enumeration via the app-server `model/list` JSON-RPC method.
 *
 * Spawns `codex app-server`, performs the minimal handshake
 * (`initialize` → `initialized`), requests `model/list`, parses the result,
 * and tears the child down. Kept separate from the large `backend.ts` turn
 * driver (which is at its file-size cap) and deliberately self-contained —
 * it does not share the turn driver's RPC client.
 *
 * The `model/list` response schema is not vendored in this repo, so the
 * parser is defensive: it accepts `{ models }`, `{ data }`, or a bare array,
 * and entries that are either bare id strings or objects with an
 * id-ish field. Any failure (spawn error, timeout, `-32601 method not
 * found` on an older codex, unparseable output) resolves to `[]` — there is
 * no default seed, so the catalog stays empty until enumeration succeeds.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { RunnerModel } from '@centraid/app-engine';
import { agentSpawnEnv } from '../../spawn-env.js';
import { lowPriorityCommand } from '../../low-priority.js';
import { safeStdinWrite } from './safe-stdin-write.js';

/** `model/list` is a local catalog read — keep the cap short. */
const MODEL_LIST_TIMEOUT_MS = 8_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

interface RpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Enumerate the models the codex app-server reports via `model/list`.
 * Returns `[]` on any failure — never throws.
 *
 * `extraArgs` must mirror what the actual chat runner passes to
 * `codex app-server` (see runtime.ts → CodexTurnConfig.extraArgs):
 * a configured `-c`/profile flag changes which models codex serves, so
 * enumerating without it would populate the catalog with ids the real
 * runner can't run.
 */
export function enumerateCodexModels(
  binPath?: string,
  extraArgs: string[] = [],
): Promise<RunnerModel[]> {
  return new Promise<RunnerModel[]>((resolve) => {
    let child: ChildProcessByStdio<Writable, Readable, Readable>;
    try {
      // `binPath` (raw, possibly undefined) drives sanitization: an explicit
      // caller-supplied path bypasses it; the bare-name default ('codex') is
      // resolved off a sanitized PATH so a stray dev-toolchain shim can't
      // shadow the user's real install (see spawn-env.ts).
      const command = lowPriorityCommand(binPath ?? 'codex', ['app-server', ...extraArgs]);
      child = spawn(command.bin, command.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: agentSpawnEnv({ binPath }),
      }) as ChildProcessByStdio<Writable, Readable, Readable>;
    } catch {
      resolve([]);
      return;
    }

    let settled = false;
    let nextId = 0;
    let buffer = '';
    let timer: ReturnType<typeof setTimeout>;
    const pending = new Map<number, (msg: RpcMessage) => void>();

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
      if (!child.killed) child.kill('SIGTERM');
      fn();
    };

    timer = setTimeout(() => finish(() => resolve([])), MODEL_LIST_TIMEOUT_MS);
    timer.unref?.();

    const send = (msg: object): void => {
      // Same closed-pipe policy as the turn backend.
      safeStdinWrite(child.stdin, JSON.stringify(msg) + '\n');
    };

    const request = (method: string, params: unknown): Promise<RpcMessage> =>
      new Promise<RpcMessage>((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        send({ jsonrpc: '2.0', id, method, params });
      });

    child.on('error', () => finish(() => resolve([])));
    child.on('exit', () => finish(() => resolve([])));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => {
      /* drain so the pipe never blocks */
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_OUTPUT_BYTES) buffer = buffer.slice(-MAX_OUTPUT_BYTES);
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('{')) {
          try {
            const msg = JSON.parse(line) as RpcMessage;
            if (
              typeof msg.id === 'number' &&
              (msg.result !== undefined || msg.error !== undefined)
            ) {
              const cb = pending.get(msg.id);
              if (cb) {
                pending.delete(msg.id);
                cb(msg);
              }
            }
          } catch {
            /* skip unparseable line */
          }
        }
        nl = buffer.indexOf('\n');
      }
    });

    void (async () => {
      try {
        const init = await request('initialize', {
          clientInfo: { name: 'centraid-local-runner', title: 'Centraid', version: '0.1.0' },
          capabilities: { experimentalApi: true },
        });
        if (init.error) return finish(() => resolve([]));
        send({ jsonrpc: '2.0', method: 'initialized', params: {} });

        const res = await request('model/list', {});
        if (res.error) return finish(() => resolve([]));
        const models = parseModelList(res.result);
        finish(() => resolve(models));
      } catch {
        finish(() => resolve([]));
      }
    })();
  });
}

/**
 * Defensive parser for the `model/list` result. Accepts `{ models }`,
 * `{ data }`, or a bare array; entries may be bare id strings or objects
 * with an id-ish field. Unknown shapes yield `[]`.
 */
export function parseModelList(result: unknown): RunnerModel[] {
  const entries = extractEntries(result);
  if (!entries) return [];
  const defaultId = extractDefaultId(result);
  const seen = new Set<string>();
  const models: RunnerModel[] = [];
  for (const raw of entries) {
    const model = toRunnerModel(raw);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    if (defaultId && model.id === defaultId) model.default = true;
    models.push(model);
  }
  return models;
}

function extractEntries(result: unknown): unknown[] | undefined {
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object') {
    const obj = result as Record<string, unknown>;
    if (Array.isArray(obj.models)) return obj.models;
    if (Array.isArray(obj.data)) return obj.data;
    if (Array.isArray(obj.items)) return obj.items;
  }
  return undefined;
}

function extractDefaultId(result: unknown): string | undefined {
  if (result && typeof result === 'object') {
    const obj = result as Record<string, unknown>;
    const candidate = obj.default ?? obj.defaultModel ?? obj.selected;
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  return undefined;
}

function toRunnerModel(raw: unknown): RunnerModel | undefined {
  if (typeof raw === 'string') {
    const id = raw.trim();
    return id ? { id } : undefined;
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const id = firstString(obj.id, obj.model, obj.slug, obj.name);
  if (!id) return undefined;
  const model: RunnerModel = { id };
  const name = firstString(obj.displayName, obj.label, obj.name);
  if (name && name !== id) model.name = name;
  if (obj.default === true || obj.isDefault === true || obj.selected === true) model.default = true;
  return model;
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}
