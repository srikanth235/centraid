import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { McpServer } from "@agentclientprotocol/sdk";

import type { ToolContext } from "@centraid/server/engine";

import {
  VAULT_CONTENT_TOOL,
  VAULT_INVOKE_TOOL,
  VAULT_SQL_TOOL,
  runVaultContentTool,
  runVaultInvokeTool,
  runVaultSqlTool,
} from "../../vault-sql-tool.js";

const MCP_PATH = "/mcp";
export const VAULT_MCP_SERVER_NAME = "centraid";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const KNOWN_PROTOCOL_VERSIONS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
]);
const MAX_BODY_BYTES = 1024 * 1024;

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

export interface VaultMcpHooks {
  onStart?: (call: VaultMcpToolStart) => void;
  onResult?: (call: VaultMcpToolResult) => void;
}

export interface VaultMcpHandle {
  readonly server: Extract<McpServer, { type: "http" }>;
  close: () => Promise<void>;
}

export type VaultMcpSideEffect = "none" | "write";

export interface VaultMcpToolRegistration {
  readonly descriptor:
    | typeof VAULT_SQL_TOOL
    | typeof VAULT_INVOKE_TOOL
    | typeof VAULT_CONTENT_TOOL;
  readonly sideEffect: VaultMcpSideEffect;
  readonly consent: "owner-read" | "capability-confirmation";
  readonly ledger: true;
  readonly available: (ctx: ToolContext) => boolean;
  readonly run: (
    ctx: ToolContext,
    args: Record<string, unknown>
  ) => ReturnType<typeof runVaultSqlTool>;
}

export const VAULT_MCP_TOOL_REGISTRY: readonly VaultMcpToolRegistration[] = [
  {
    descriptor: VAULT_SQL_TOOL,
    sideEffect: "none",
    consent: "owner-read",
    ledger: true,
    available: (ctx) => Boolean(ctx.vaultSql),
    run: (ctx, args) => runVaultSqlTool(ctx, args.sql),
  },
  {
    descriptor: VAULT_INVOKE_TOOL,
    sideEffect: "write",
    consent: "capability-confirmation",
    ledger: true,
    available: (ctx) => Boolean(ctx.vaultInvoke),
    run: (ctx, args) => runVaultInvokeTool(ctx, args),
  },
  {
    descriptor: VAULT_CONTENT_TOOL,
    sideEffect: "none",
    consent: "owner-read",
    ledger: true,
    available: (ctx) => Boolean(ctx.vaultContent),
    run: (ctx, args) => runVaultContentTool(ctx, args),
  },
] as const;

function toolsFor(ctx: ToolContext): Array<{
  name: string;
  description: string;
  inputSchema: unknown;
}> {
  return VAULT_MCP_TOOL_REGISTRY.filter((tool) => tool.available(ctx)).map(
    (tool) => ({ ...tool.descriptor })
  );
}

async function callTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>
): Promise<{ ok: true; result: unknown } | { ok: false; errorText: string }> {
  const tool = VAULT_MCP_TOOL_REGISTRY.find(
    (candidate) => candidate.descriptor.name === name
  );
  if (tool?.available(ctx)) return tool.run(ctx, args);
  return { ok: false, errorText: `unknown tool "${name}"` };
}

function bearerOk(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const match = /^Bearer[ \t]+(?<token>\S+)$/iu.exec(header.trim());
  const presented = match?.groups?.token;
  if (!presented) return false;
  const given = Buffer.from(presented, "utf8");
  const want = Buffer.from(token, "utf8");
  return given.length === want.length && timingSafeEqual(given, want);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(text)),
  });
  res.end(text);
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export async function startVaultMcpServer(
  ctx: ToolContext,
  hooks: VaultMcpHooks = {}
): Promise<VaultMcpHandle> {
  const token = randomBytes(32).toString("hex");
  let nextCallSeq = 0;

  const dispatch = async (
    body: JsonRpcRequest
  ): Promise<unknown | undefined> => {
    const { id, method } = body;
    const isNotification = id === undefined || id === null;
    const ok = (result: unknown): unknown => ({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string): unknown => ({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    });

    if (method === "initialize") {
      const asked = body.params?.protocolVersion;
      const version =
        typeof asked === "string" && KNOWN_PROTOCOL_VERSIONS.has(asked)
          ? asked
          : DEFAULT_PROTOCOL_VERSION;
      return ok({
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: VAULT_MCP_SERVER_NAME, version: "1.0.0" },
      });
    }
    if (method === "ping") return ok({});
    if (method === "tools/list") return ok({ tools: toolsFor(ctx) });
    if (method === "tools/call") {
      const name =
        typeof body.params?.name === "string" ? body.params.name : "";
      const raw = body.params?.arguments;
      const args =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {};
      const toolCallId = `vault-${++nextCallSeq}`;
      hooks.onStart?.({ toolCallId, toolName: name, args });
      const out = await callTool(ctx, name, args);
      if (out.ok) {
        hooks.onResult?.({
          toolCallId,
          toolName: name,
          ok: true,
          result: out.result,
        });
        return ok({
          content: [{ type: "text", text: JSON.stringify(out.result) }],
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
      return ok({
        content: [{ type: "text", text: out.errorText }],
        isError: true,
      });
    }
    if (isNotification) return undefined; // initialized / cancelled / progress
    return fail(-32601, `method not found: ${String(method)}`);
  };

  const handle = async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== MCP_PATH) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    if (!bearerOk(req.headers.authorization, token)) {
      res.setHeader("www-authenticate", "Bearer");
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }

    let body: JsonRpcRequest;
    try {
      const text = await readBody(req);
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        sendJson(res, 400, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "expected a single JSON-RPC object" },
        });
        return;
      }
      body = parsed as JsonRpcRequest;
    } catch {
      sendJson(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "parse error" },
      });
      return;
    }

    let response: unknown;
    try {
      response = await dispatch(body);
    } catch (error) {
      sendJson(res, 200, {
        jsonrpc: "2.0",
        id: body.id ?? null,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
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
      if (res.headersSent) {
        res.end();
      } else {
        sendJson(res, 500, { error: "internal error" });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => {
      http.removeListener("error", reject);
      resolve();
    });
  });

  const address = http.address() as AddressInfo | null;
  if (!address) {
    http.close();
    throw new Error("vault MCP server did not bind a port");
  }

  let closed = false;
  return {
    server: {
      type: "http",
      name: VAULT_MCP_SERVER_NAME,
      url: `http://127.0.0.1:${address.port}${MCP_PATH}`,
      headers: [{ name: "Authorization", value: `Bearer ${token}` }],
    },
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      });
    },
  };
}
