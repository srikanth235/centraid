/*
 * The JSON-RPC 2.0 transport the ACP backend drives an agent over: stdio with
 * newline-delimited JSON, a pending-request map, and a dispatcher that splits
 * inbound frames into responses, server→client requests, and notifications.
 *
 * The client is hand-authored against the public ACP spec
 * (https://agentclientprotocol.com) — no ACP SDK dependency.
 *
 * Nothing about ACP's semantics lives here; this module only knows frames.
 * The one exception is `AUTH_REQUIRED_CODE`, which exists because the code
 * has to survive the trip from the wire to the error handler.
 */

import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { safeStdinWrite } from './safe-stdin-write.js';

/** Protocol major version we speak (single integer per the spec). */
export const ACP_PROTOCOL_VERSION = 1;

/**
 * ACP's `AUTH_REQUIRED` JSON-RPC error (verified against the SDK's
 * `RequestError.authRequired`, which mints code -32000 in the
 * protocol-reserved range). 18 of the 31 agents in the ACP registry answer
 * `session/new` with this until the user has signed their CLI in, so it is
 * the single most likely first-run failure — worth a real answer instead of
 * a raw RPC string.
 */
export const AUTH_REQUIRED_CODE = -32000;

/** JSON-RPC "method not found" — our answer to capabilities we never advertised. */
const METHOD_NOT_FOUND = -32601;

/** How much of the agent's stderr we keep for a failure message. */
const STDERR_TAIL_BYTES = 64 * 1024;

interface PendingResponse {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

interface RpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * A JSON-RPC error the agent returned, with its `code` preserved. Without
 * this the code was flattened into a string and `AUTH_REQUIRED` was
 * indistinguishable from any other failure.
 */
export class AcpRpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'AcpRpcError';
    this.code = code;
  }
}

export interface AcpConnectionHandlers {
  /** A request the agent sent us (has both `id` and `method`). */
  onServerRequest: (id: number | string, method: string, params: unknown) => void;
  /** A notification the agent sent us (`method`, no `id`). */
  onNotification: (method: string, params: unknown) => void;
}

export interface AcpConnection {
  /** Fire-and-forget frame (notifications, and the raw responses below). */
  send: (msg: object) => void;
  /** Request/response with a fresh id; rejects with `AcpRpcError` on a wire error. */
  request: <T = unknown>(method: string, params: unknown) => Promise<T>;
  /** Answer a server→client request with a result. */
  respond: (id: number | string, result: unknown) => void;
  /** Decline a server→client request we have no capability for. */
  respondMethodNotFound: (id: number | string, method: string) => void;
  /**
   * Rebind server→client handlers for the next turn on a warm-reused process.
   * Handlers close over turn-local emit/stream state, so a parked connection
   * must rebind before the next `session/prompt`.
   */
  setHandlers: (next: AcpConnectionHandlers) => void;
  /** Resolves once the child has exited or failed to spawn. */
  readonly exited: Promise<void>;
  /** True once the child is gone — pending requests have already been rejected. */
  hasExited: () => boolean;
  /** A spawn-level failure (`child.on('error')`), if any. */
  spawnError: () => Error | undefined;
  /** Trailing stderr, for attaching to a failure message. */
  stderrTail: () => string;
}

/**
 * Wire a spawned agent's stdio up as a JSON-RPC peer. Listeners are attached
 * synchronously, so no frame emitted by a fast-starting agent is lost.
 */
export function createAcpConnection(
  child: ChildProcessByStdio<Writable, Readable, Readable>,
  handlers: AcpConnectionHandlers,
): AcpConnection {
  let nextId = 0;
  const pending = new Map<number, PendingResponse>();
  let buffer = '';
  let stderrBuf = '';
  let processExited = false;
  let exitError: Error | undefined;
  let activeHandlers = handlers;

  const send = (msg: object): void => {
    safeStdinWrite(child.stdin, JSON.stringify(msg) + '\n');
  };

  const request = <T = unknown>(method: string, params: unknown): Promise<T> => {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: (v) => resolve(v as T), reject });
      send({ jsonrpc: '2.0', id, method, params });
    });
  };

  const respond = (id: number | string, result: unknown): void => {
    send({ jsonrpc: '2.0', id, result });
  };

  const respondMethodNotFound = (id: number | string, method: string): void => {
    send({
      jsonrpc: '2.0',
      id,
      error: { code: METHOD_NOT_FOUND, message: `method not found: ${method}` },
    });
  };

  const handleMessage = (msg: RpcMessage): void => {
    if (typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new AcpRpcError(msg.error.code, msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined && msg.method) {
      activeHandlers.onServerRequest(msg.id, msg.method, msg.params);
      return;
    }
    if (msg.method) activeHandlers.onNotification(msg.method, msg.params);
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line && line.startsWith('{')) {
        try {
          handleMessage(JSON.parse(line) as RpcMessage);
        } catch {
          // unparseable line — skip
        }
      }
      nl = buffer.indexOf('\n');
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrBuf = (stderrBuf + chunk).slice(-STDERR_TAIL_BYTES);
  });

  const exited = new Promise<void>((resolve) => {
    child.on('error', (err) => {
      exitError = err;
      processExited = true;
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      resolve();
    });
    child.on('exit', () => {
      processExited = true;
      const err = new Error('acp agent exited');
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      resolve();
    });
  });

  return {
    send,
    request,
    respond,
    respondMethodNotFound,
    setHandlers: (next) => {
      activeHandlers = next;
    },
    exited,
    hasExited: () => processExited,
    spawnError: () => exitError,
    stderrTail: () => stderrBuf,
  };
}
