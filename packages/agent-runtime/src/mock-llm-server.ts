/**
 * Ephemeral HTTP "mock LLM" server for the local automation runtime.
 *
 * The unlock (see issue #70 § Mock-LLM server): point a host CLI
 * (`codex exec` / `claude -p`) at a dummy inference endpoint that
 * returns pre-scripted tool-call responses. The CLI's tool dispatch +
 * MCP + auth machinery executes the calls through the user's real
 * integrations, returns `tool_result` blocks back through the mock,
 * which then returns "done." Zero real LLM tokens are consumed by the
 * outer turn — only by `ctx.agent` calls that route through a
 * different (real) provider.
 *
 * This module ships **all three wire protocols** so the same server
 * serves either CLI:
 *
 *   - Anthropic Messages      — `POST /v1/messages`           (claude -p)
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
 * Concurrency model: callers `stageTurn(dispatchId, response)` before
 * spawning the CLI. The CLI's first POST consumes the staged turn; if
 * the CLI follows up after `tool_result` (the back-half of a tool-use
 * round-trip), the caller stages a second turn (typically the
 * `stopReason: 'end_turn'` ack) before the CLI replies. If a request
 * arrives with no staged turn, the mock returns 503 — failing loudly
 * rather than fabricating a response the host would mistake for real.
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
   * Throws if a turn is already staged (caller bug — would silently lose
   * a response). Replacements are explicit via `clearStaged(dispatchId)`.
   */
  stageTurn(dispatchId: string, turn: StagedTurn): void;
  clearStaged(dispatchId: string): void;
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

    const turn = staged.get(dispatchId);
    if (!turn) {
      // Failing loudly is by design: silently returning "ok" would mask
      // missing dispatcher logic upstream.
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'no staged turn for this dispatch' } }));
      return;
    }
    staged.delete(dispatchId);

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
      if (staged.has(dispatchId)) {
        throw new Error(`a turn is already staged for dispatch ${dispatchId}`);
      }
      staged.set(dispatchId, turn);
    },
    clearStaged(dispatchId) {
      staged.delete(dispatchId);
    },
    mintDispatchToken() {
      const dispatchId = randomBytes(16).toString('hex');
      validDispatchIds.add(dispatchId);
      return { dispatchId, bearerToken: `${BEARER_PREFIX}${dispatchId}` };
    },
    close() {
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
