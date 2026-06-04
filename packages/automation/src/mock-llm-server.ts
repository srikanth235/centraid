/**
 * Ephemeral HTTP "mock LLM" server for the local automation runtime.
 *
 * The unlock (see issue #70 § Mock-LLM server): point a host agent
 * (`codex exec`, or the in-process Claude Agent SDK) at a dummy inference
 * endpoint that returns pre-scripted tool-call responses. The agent's tool
 * dispatch + MCP + auth machinery executes the calls through the user's real
 * integrations, returns `tool_result` blocks back through the mock,
 * which then returns "done." Zero real LLM tokens are consumed by the
 * outer turn — only by `ctx.agent` calls that route through a
 * different (real) provider.
 *
 * This module ships **all three wire protocols** so the same server
 * serves either runner:
 *
 *   - Anthropic Messages      — `POST /v1/messages`           (Claude Agent SDK)
 *   - OpenAI Responses        — `POST /v1/responses`          (codex exec)
 *   - OpenAI Chat Completions — `POST /v1/chat/completions`   (legacy)
 *
 * codex 0.128+ dropped `wire_api = "chat"`; the codex provider config
 * now sets `wire_api = "responses"`, so codex hits `/v1/responses`. The
 * Chat Completions adapter is kept for any provider still on that wire.
 *
 * The server is per-run: a fresh server starts before each
 * `centraid run-automation` invocation, binds to 127.0.0.1 on a
 * random port, requires a per-spawn bearer token, and dies when the
 * run ends. There is **no long-lived daemon**.
 *
 * The dispatch_id correlation pattern from the issue is preserved: the
 * bearer token IS the dispatch id, embedded in `Authorization: Bearer
 * centraid-mock-<dispatch_id>`. Both protocols carry this header, so
 * the mock can route requests to per-dispatch staged responses without
 * relying on the host CLI to forward custom body fields.
 *
 * Concurrency model (issue #166 — persistent session): the mock is a
 * long-lived multi-turn session, not a per-batch one-shot. A single agent
 * session is opened per fire and stays alive across every `ctx.tool`
 * batch; the mock dictates each turn. When an agent request arrives and no
 * turn is staged yet — because the deterministic handler hasn't reached
 * its next `ctx.tool` call — the mock **awaits** (it does not 503),
 * holding the HTTP request open until the driver `stageTurn`s the next
 * turn. This is the structural guarantee of a single controlled session:
 * the handler drives, the mock paces the agent, and the agent loops until the
 * driver finally stages an `end_turn` (via `endDispatch`) and the session
 * exits. An awaiting request is released with a benign `end_turn` if the
 * dispatch is ended (teardown) or the client disconnects, so teardown
 * never hangs.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import {
  writeAnthropicMessages,
  writeOpenAiChatCompletions,
  writeOpenAiResponses,
} from './mock-llm-writers.js';

/**
 * One pre-staged "agent turn" the mock will emit on the next CLI
 * request matching its dispatch id. The shape is canonical — both
 * protocol adapters translate it into the on-wire SSE / JSON form.
 *
 * `toolUses` express what tools the CLI should invoke this turn.
 * Each entry carries a unique `id` the CLI uses to correlate the
 * `tool_result` reply.
 *
 * `text` is the assistant message body. Almost always empty when the
 * turn carries tool calls; populated only on the final "ok" turn.
 *
 * `stopReason` mirrors the Anthropic terminology (`"end_turn"` vs
 * `"tool_use"`). The OpenAI translator maps these to its own enum.
 */
export interface StagedTurn {
  /** Tool calls the host CLI must execute through its MCP pipeline. */
  toolUses?: ReadonlyArray<{
    /** Stable id, returned in the matching `tool_result`. */
    id: string;
    /** Fully-qualified tool name. */
    name: string;
    /** JSON-serialisable args object. */
    input: unknown;
  }>;
  /** Assistant text content for this turn. */
  text?: string;
  /** `"tool_use"` when toolUses are present; `"end_turn"` for the final ack. */
  stopReason: 'tool_use' | 'end_turn';
}

/**
 * `Tool result` block(s) extracted from a CLI inbound request that
 * is the follow-up after a `tool_use` turn. Surfaced to the caller
 * via the `onToolResults` callback so the orchestrator can wire each
 * result back to the pending Promise in the worker.
 */
export interface CapturedToolResult {
  /** The `tool_use_id` the CLI ran. */
  id: string;
  /** Raw textual result the CLI returned. */
  content: string;
  /** True when the CLI reported an error from the tool execution. */
  isError: boolean;
}

/** A tool the mock is about to hand the CLI to execute. */
export interface StagedToolUse {
  id: string;
  name: string;
}

export interface MockLlmServerOptions {
  /**
   * Optional callback fired the moment the mock returns a turn containing
   * `tool_use` blocks — i.e. the instant the CLI is handed the staged calls
   * to execute. Pairs with `onToolResults` (the finish side) to give the
   * orchestrator real per-tool start/finish timing (issue #158, Phase 3),
   * excluding the CLI spawn/teardown that brackets the whole batch.
   */
  onToolStart?: (dispatchId: string, toolUses: StagedToolUse[]) => void;
  /**
   * Optional callback fired every time a CLI request lands carrying
   * `tool_result` blocks. Lets the orchestrator unblock the worker's
   * `ctx.tool` Promises without polling the server.
   */
  onToolResults?: (dispatchId: string, results: CapturedToolResult[]) => void;
  /**
   * Optional callback fired with the parsed body of every authenticated
   * POST, before the staged-turn lookup. The host-tool enumeration probe
   * uses this to snapshot the `tools` array the CLI ships to the model —
   * the canonical source of truth for tool names + JSON schemas.
   */
  onRequest?: (dispatchId: string, body: Record<string, unknown>) => void;
  /** Optional logger for diagnostics. */
  onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export interface MockLlmServerHandle {
  /** `127.0.0.1:<port>`. */
  readonly host: string;
  readonly port: number;
  /** `http://127.0.0.1:<port>/v1` — feed this to the CLI's base_url config. */
  readonly baseUrl: string;
  /**
   * Stage the next turn the mock will return for the given dispatch id.
   * If a CLI request is already parked awaiting a turn, it is released
   * immediately with this turn. Otherwise the turn is buffered for the
   * next request. Throws if a turn is already buffered (caller bug —
   * would silently lose a response). Replacements are explicit via
   * `clearStaged(dispatchId)`.
   */
  stageTurn(dispatchId: string, turn: StagedTurn): void;
  clearStaged(dispatchId: string): void;
  /**
   * End a persistent dispatch (issue #166): release any parked request
   * with a benign `end_turn` so the agent session finishes and exits, and
   * drop all buffered/waiter state for the id. Idempotent.
   */
  endDispatch(dispatchId: string): void;
  /** Mint a fresh per-spawn bearer token (`centraid-mock-<uuid>`). */
  mintDispatchToken(): { dispatchId: string; bearerToken: string };
  close(): Promise<void>;
}

const BEARER_PREFIX = 'centraid-mock-';

/**
 * Start a mock-LLM server on 127.0.0.1 with a random port. Returns
 * once the server is listening.
 */
export async function startMockLlmServer(
  opts: MockLlmServerOptions = {},
): Promise<MockLlmServerHandle> {
  const staged = new Map<string, StagedTurn>();
  const validDispatchIds = new Set<string>();
  // Persistent-session waiters (issue #166): a CLI request that arrives
  // before the driver has staged its next turn parks here until `stageTurn`
  // (or `endDispatch`) releases it. FIFO per dispatch — the handler is
  // serialized (it awaits each `ctx.tool` before the next), so in practice
  // there is at most one parked request per dispatch, but a queue keeps the
  // contract correct under any interleaving.
  const waiters = new Map<string, Array<(turn: StagedTurn) => void>>();

  /** A benign final turn used to release a parked request on teardown. */
  const END_TURN: StagedTurn = { text: '', stopReason: 'end_turn' };

  /**
   * Resolve the next turn for a dispatch: consume a buffered turn if one is
   * staged, else park until `stageTurn`/`endDispatch` releases the request.
   * Releases with `END_TURN` if the client disconnects so the handler unwinds.
   */
  const awaitTurn = (dispatchId: string, req: IncomingMessage): Promise<StagedTurn> => {
    const buffered = staged.get(dispatchId);
    if (buffered) {
      staged.delete(dispatchId);
      return Promise.resolve(buffered);
    }
    return new Promise<StagedTurn>((resolve) => {
      let settled = false;
      const settle = (turn: StagedTurn): void => {
        if (settled) return;
        settled = true;
        resolve(turn);
      };
      const queue = waiters.get(dispatchId) ?? [];
      queue.push(settle);
      waiters.set(dispatchId, queue);
      // A dropped connection must not strand the request forever.
      req.once('close', () => {
        const q = waiters.get(dispatchId);
        if (q) {
          const idx = q.indexOf(settle);
          if (idx >= 0) q.splice(idx, 1);
        }
        settle(END_TURN);
      });
    });
  };

  const log = (level: 'info' | 'warn' | 'error', msg: string): void => {
    opts.onLog?.(level, msg);
  };

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((err: unknown) => {
      log('error', `mock-llm handler crashed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'mock-llm internal error' } }));
      } else {
        res.end();
      }
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';

    if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
      // Both Anthropic and OpenAI allow a GET /models healthcheck; some
      // preflights probe it. Reply with a single synthetic model id so
      // the probe succeeds without leaking real model names.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'centraid-mock-run-automation', object: 'model' }],
        }),
      );
      return;
    }

    const bearer = parseBearer(req);
    if (!bearer || !bearer.startsWith(BEARER_PREFIX)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'missing or malformed bearer token' } }));
      return;
    }
    const dispatchId = bearer.slice(BEARER_PREFIX.length);
    if (!validDispatchIds.has(dispatchId)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unknown dispatch id' } }));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      res.end();
      return;
    }

    const body = await readBody(req);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid JSON body' } }));
      return;
    }

    // Surface the raw request to any observer (tool-enumeration probe)
    // before we touch the staged-turn machinery.
    opts.onRequest?.(dispatchId, parsed);

    // Sniff for tool_result blocks in any protocol so we can route
    // them to the orchestrator before assembling the next response.
    const results = extractToolResults(parsed);
    if (results.length > 0 && opts.onToolResults) {
      opts.onToolResults(dispatchId, results);
    }

    // Persistent session (issue #166): if the handler hasn't reached its
    // next `ctx.tool` yet, no turn is staged — park the request until the
    // driver stages one rather than 503-ing. `endDispatch` / a dropped
    // connection releases it with a benign `end_turn` so nothing hangs.
    const turn = await awaitTurn(dispatchId, req);
    if (res.writableEnded) {
      // The client disconnected while we were parked; nothing to write.
      return;
    }

    // Per-tool start signal: this turn is about to hand the CLI its staged
    // tool calls (issue #158, Phase 3). Fires before the response is written.
    if (opts.onToolStart && turn.toolUses && turn.toolUses.length > 0) {
      opts.onToolStart(
        dispatchId,
        turn.toolUses.map((u) => ({ id: u.id, name: u.name })),
      );
    }

    if (url.startsWith('/v1/messages')) {
      writeAnthropicMessages(req, res, turn);
      return;
    }
    if (url.startsWith('/v1/responses')) {
      writeOpenAiResponses(req, res, turn);
      return;
    }
    if (url.startsWith('/v1/chat/completions')) {
      writeOpenAiChatCompletions(req, res, turn);
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `unknown endpoint: ${url}` } }));
  }

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const host = `127.0.0.1:${addr.port}`;
  const baseUrl = `http://${host}/v1`;
  log('info', `mock-llm listening at ${baseUrl}`);

  return {
    host,
    port: addr.port,
    baseUrl,
    stageTurn(dispatchId, turn) {
      if (!validDispatchIds.has(dispatchId)) {
        throw new Error(`unknown dispatch id: ${dispatchId}`);
      }
      // Release a parked CLI request directly — it never touches `staged`.
      const queue = waiters.get(dispatchId);
      if (queue && queue.length > 0) {
        const release = queue.shift()!;
        if (queue.length === 0) waiters.delete(dispatchId);
        release(turn);
        return;
      }
      if (staged.has(dispatchId)) {
        throw new Error(`a turn is already staged for dispatch ${dispatchId}`);
      }
      staged.set(dispatchId, turn);
    },
    clearStaged(dispatchId) {
      staged.delete(dispatchId);
    },
    endDispatch(dispatchId) {
      staged.delete(dispatchId);
      const queue = waiters.get(dispatchId);
      if (queue) {
        waiters.delete(dispatchId);
        for (const release of queue) release(END_TURN);
      }
    },
    mintDispatchToken() {
      const dispatchId = randomBytes(16).toString('hex');
      validDispatchIds.add(dispatchId);
      return { dispatchId, bearerToken: `${BEARER_PREFIX}${dispatchId}` };
    },
    close() {
      // Release every parked request so no open connection blocks the close.
      for (const [, queue] of waiters) {
        for (const release of queue) release(END_TURN);
      }
      waiters.clear();
      return new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}

function parseBearer(req: IncomingMessage): string | undefined {
  const raw = req.headers.authorization ?? req.headers['x-api-key'];
  if (!raw) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  if (value.toLowerCase().startsWith('bearer ')) return value.slice(7);
  return value;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Search the Anthropic-style, OpenAI Chat, and OpenAI Responses request
 * bodies for tool results. Returns one entry per result block.
 */
function extractToolResults(body: Record<string, unknown>): CapturedToolResult[] {
  const out: CapturedToolResult[] = [];
  // OpenAI Responses: { input: [{ type: "function_call_output", call_id,
  // output }, ...] }. The CLI re-sends prior turns in `input`; only the
  // function_call_output items are tool results.
  const input = body.input;
  if (Array.isArray(input)) {
    for (const item of input) {
      if (!isObject(item)) continue;
      if (item.type === 'function_call_output') {
        const id = typeof item.call_id === 'string' ? item.call_id : '';
        out.push({ id, content: stringifyContent(item.output), isError: false });
      }
    }
  }
  // Anthropic Messages: { messages: [{ role: "user", content: [{ type:
  // "tool_result", tool_use_id, content, is_error? }, ...] }] }
  const messages = (body.messages as unknown[] | undefined) ?? [];
  for (const msg of messages) {
    if (!isObject(msg)) continue;
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!isObject(block)) continue;
        if (block.type === 'tool_result') {
          const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
          const isError = block.is_error === true;
          out.push({ id, content: stringifyContent(block.content), isError });
        }
      }
    }
    // OpenAI Chat Completions: { messages: [{ role: "tool",
    // tool_call_id, content }, ...] }
    if (msg.role === 'tool') {
      const id = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : '';
      out.push({ id, content: stringifyContent(msg.content), isError: false });
    }
  }
  return out;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function stringifyContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    // Anthropic allows text blocks inside tool_result content.
    return value
      .map((b) => {
        if (typeof b === 'string') return b;
        if (isObject(b) && typeof b.text === 'string') return b.text;
        return JSON.stringify(b);
      })
      .join('');
  }
  return JSON.stringify(value ?? '');
}

// Re-export the type so callers / tests can build server handles
// without re-importing from node:http.
export type { Server };
