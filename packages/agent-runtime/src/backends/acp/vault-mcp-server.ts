/*
 * Loopback MCP server exposing the vault tools to whatever ACP agent the
 * turn spawned (issue #479).
 *
 * Before the ACP fold, each bespoke backend reached the vault through its
 * CLI's own tool surface: claude got an in-process MCP server, codex got
 * `dynamicTools`. ACP has no client-hosted tool surface we can use — the
 * `type: "acp"` MCP transport is experimental and NEITHER first-party
 * adapter implements it (`mcpCapabilities.acp: false` in both). What both
 * DO advertise is `mcpCapabilities.http: true`, so the way back to the
 * vault is a real MCP server over HTTP, named in the `mcpServers` array of
 * `session/new` / `session/load`.
 *
 * That makes the capability generic instead of per-kind: gemini and qwen —
 * which never had vault tools under the bespoke backends — get them too,
 * for free, the moment they advertise HTTP MCP support.
 *
 * Security posture. This endpoint hands out owner-credentialed SQL over the
 * whole vault plus the typed write path, so it is treated as sensitive:
 *
 *   - bound to 127.0.0.1 on an ephemeral port, never 0.0.0.0;
 *   - every request must carry a per-turn `Authorization: Bearer <token>`
 *     of 256 random bits, compared in constant time;
 *   - the token is minted per turn, passed to the agent only through the
 *     `mcpServers` entry's headers, and never logged;
 *   - the listener is closed (with its sockets) in the turn's `finally`, so
 *     no port outlives the turn that opened it — including on abort.
 *
 * Transport. This is a minimal hand-rolled MCP "Streamable HTTP" server
 * rather than `@modelcontextprotocol/sdk`: the SDK would add express, hono,
 * cors and jose to a package whose entire need here is three tools behind
 * one POST route. The surface implemented is exactly what a tools-only
 * server needs — `initialize`, `notifications/initialized`, `ping`,
 * `tools/list`, `tools/call` — served as plain JSON responses (the spec
 * lets a server answer a POST with `application/json` instead of SSE), with
 * no session id (a stateless server is spec-legal, so clients have nothing
 * to echo back). GET/DELETE answer 405, which is how the spec says a server
 * declines to offer a standalone SSE stream.
 *
 * The tool names, descriptions and JSON schemas come verbatim from
 * `vault-sql-tool.ts` — the same module the retired backends used — so
 * prompts and skills that name `vault_sql` / `vault_invoke` /
 * `vault_content` keep working unchanged. The server is also still named
 * `centraid`, so a namespacing agent surfaces `mcp__centraid__vault_sql`
 * exactly as the claude backend did.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ToolContext } from '@centraid/app-engine';
import {
  VAULT_CONTENT_TOOL,
  VAULT_INVOKE_TOOL,
  VAULT_SQL_TOOL,
  runVaultContentTool,
  runVaultInvokeTool,
  runVaultSqlTool,
} from '../../vault-sql-tool.js';

/** The single route; anything else 404s. */
const MCP_PATH = '/mcp';
/** MCP server name — kept from the retired claude MCP server for prompt parity. */
export const VAULT_MCP_SERVER_NAME = 'centraid';
/** Answered when the client asks for a version we don't recognise. */
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
/** A tools-only surface is identical across these, so we echo the client's pick. */
const KNOWN_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
/** Request bodies are three small JSON args; anything larger is not ours. */
const MAX_BODY_BYTES = 1024 * 1024;

/** The `mcpServers` entry shape from ACP's `McpServerHttp` (schema-verified). */
export interface AcpHttpMcpServer {
  type: 'http';
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
}

export interface VaultMcpToolStart {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface VaultMcpToolResult {
  toolCallId: string;
  toolName: string;
  ok: boolean;
  result: unknown;
  errorText?: string;
}

/**
 * Observation hooks for the turn driver. The backend decides whether these
 * become `tool.start` / `tool.result` stream events — an agent that already
 * streams the MCP call as an ACP `tool_call` would otherwise double-render.
 */
export interface VaultMcpHooks {
  onStart?: (call: VaultMcpToolStart) => void;
  onResult?: (call: VaultMcpToolResult) => void;
}

export interface VaultMcpHandle {
  /** Hand this to the agent in `session/new` / `session/load`. */
  readonly server: AcpHttpMcpServer;
  /** Close the listener and drop any live sockets. Idempotent. */
  close: () => Promise<void>;
}

/** The tool descriptors this turn's `ToolContext` can actually serve. */
function toolsFor(ctx: ToolContext): Array<{
  name: string;
  description: string;
  inputSchema: unknown;
}> {
  return [
    { ...VAULT_SQL_TOOL },
    ...(ctx.vaultInvoke ? [{ ...VAULT_INVOKE_TOOL }] : []),
    ...(ctx.vaultContent ? [{ ...VAULT_CONTENT_TOOL }] : []),
  ];
}

async function callTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; result: unknown } | { ok: false; errorText: string }> {
  if (name === VAULT_SQL_TOOL.name) return runVaultSqlTool(ctx, args.sql);
  if (name === VAULT_INVOKE_TOOL.name) return runVaultInvokeTool(ctx, args);
  if (name === VAULT_CONTENT_TOOL.name) return runVaultContentTool(ctx, args);
  return { ok: false, errorText: `unknown tool "${name}"` };
}

/** Constant-time bearer check. Never logs, never reports which half mismatched. */
function bearerOk(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  if (!match?.[1]) return false;
  const given = Buffer.from(match[1], 'utf8');
  const want = Buffer.from(token, 'utf8');
  // timingSafeEqual throws on a length mismatch, so gate on length first.
  // Token length is not secret (it is a fixed 64 hex chars).
  return given.length === want.length && timingSafeEqual(given, want);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(text)),
  });
  res.end(text);
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * Start the per-turn vault MCP endpoint.
 *
 * Resolves once the listener is bound, so the URL handed to the agent is
 * always live by the time `session/new` mentions it.
 */
export async function startVaultMcpServer(
  ctx: ToolContext,
  hooks: VaultMcpHooks = {},
): Promise<VaultMcpHandle> {
  const token = randomBytes(32).toString('hex');
  let nextCallSeq = 0;

  const dispatch = async (body: JsonRpcRequest): Promise<unknown | undefined> => {
    const { id, method } = body;
    // A notification (no id) gets no response body — 202 is the reply.
    const isNotification = id === undefined || id === null;
    const ok = (result: unknown): unknown => ({ jsonrpc: '2.0', id, result });
    const fail = (code: number, message: string): unknown => ({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    });

    if (method === 'initialize') {
      const asked = body.params?.protocolVersion;
      const version =
        typeof asked === 'string' && KNOWN_PROTOCOL_VERSIONS.has(asked)
          ? asked
          : DEFAULT_PROTOCOL_VERSION;
      return ok({
        protocolVersion: version,
        // Tools only: advertising nothing else keeps well-behaved clients
        // from calling resources/* or prompts/* at all.
        capabilities: { tools: {} },
        serverInfo: { name: VAULT_MCP_SERVER_NAME, version: '1.0.0' },
      });
    }
    if (method === 'ping') return ok({});
    if (method === 'tools/list') return ok({ tools: toolsFor(ctx) });
    if (method === 'tools/call') {
      const name = typeof body.params?.name === 'string' ? body.params.name : '';
      const raw = body.params?.arguments;
      const args =
        raw && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {};
      const toolCallId = `vault-${++nextCallSeq}`;
      hooks.onStart?.({ toolCallId, toolName: name, args });
      const out = await callTool(ctx, name, args);
      if (out.ok) {
        hooks.onResult?.({ toolCallId, toolName: name, ok: true, result: out.result });
        return ok({
          content: [{ type: 'text', text: JSON.stringify(out.result) }],
          isError: false,
        });
      }
      hooks.onResult?.({
        toolCallId,
        toolName: name,
        ok: false,
        result: null,
        errorText: out.errorText,
      });
      // A tool that failed is a successful RPC carrying an error result —
      // that is what lets the model read the message and correct itself.
      return ok({ content: [{ type: 'text', text: out.errorText }], isError: true });
    }
    if (isNotification) return undefined; // initialized / cancelled / progress
    return fail(-32601, `method not found: ${String(method)}`);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== MCP_PATH) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (!bearerOk(req.headers.authorization, token)) {
      res.setHeader('www-authenticate', 'Bearer');
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    if (req.method !== 'POST') {
      // Spec-legal way to decline a standalone SSE stream / session delete.
      res.setHeader('allow', 'POST');
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }

    let body: JsonRpcRequest;
    try {
      const text = await readBody(req);
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        // Batching was removed in the 2025-06-18 revision; one message per POST.
        sendJson(res, 400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'expected a single JSON-RPC object' },
        });
        return;
      }
      body = parsed as JsonRpcRequest;
    } catch {
      sendJson(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'parse error' },
      });
      return;
    }

    let response: unknown;
    try {
      response = await dispatch(body);
    } catch (err) {
      // A throwing tool runner must not take the listener (or the turn) down.
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: body.id ?? null,
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      });
      return;
    }
    if (response === undefined) {
      res.writeHead(202).end();
      return;
    }
    sendJson(res, 200, response);
  };

  const http: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    // Loopback only. An ephemeral port keeps concurrent turns from colliding.
    http.listen(0, '127.0.0.1', () => {
      http.removeListener('error', reject);
      resolve();
    });
  });

  const address = http.address() as AddressInfo | null;
  if (!address) {
    http.close();
    throw new Error('vault MCP server did not bind a port');
  }

  let closed = false;
  return {
    server: {
      type: 'http',
      name: VAULT_MCP_SERVER_NAME,
      url: `http://127.0.0.1:${address.port}${MCP_PATH}`,
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
    },
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => {
        // Keep-alive sockets would hold `close` open past the turn.
        http.closeAllConnections();
        http.close(() => resolve());
      });
    },
  };
}
