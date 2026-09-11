#!/usr/bin/env node
/*
 * Stdio MCP proxy: forward initialize / tools/list / tools/call / ping to
 * CENTRAID_VAULT_MCP_URL with CENTRAID_VAULT_MCP_TOKEN. Not a public API.
 */

import { createInterface } from "node:readline";

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

const configuredUrl = process.env.CENTRAID_VAULT_MCP_URL;
const configuredToken = process.env.CENTRAID_VAULT_MCP_TOKEN;

if (!configuredUrl || !configuredToken) {
  process.stderr.write(
    "vault-mcp-stdio-proxy: CENTRAID_VAULT_MCP_URL and TOKEN required\n"
  );
  process.exit(2);
}

const url: string = configuredUrl;
const token: string = configuredToken;

const send = (msg: unknown): void => {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
};

function asMessage(value: unknown): JsonRpcMessage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return value as JsonRpcMessage;
}

async function forward(body: JsonRpcMessage): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {
      jsonrpc: "2.0",
      id: body.id ?? null,
      error: {
        code: -32000,
        message: `upstream HTTP ${res.status}: ${text.slice(0, 200)}`,
      },
    };
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return;
  }
  const msg = asMessage(parsed);
  if (!msg) return;
  // Notifications: forward fire-and-forget (no response expected).
  if (msg.method && msg.id === undefined) {
    void forward(msg).catch(() => undefined);
    return;
  }
  if (msg.method && msg.id !== undefined) {
    void forward(msg)
      .then((out) => {
        if (out && typeof out === "object") send(out);
      })
      .catch((error: unknown) => {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      });
  }
});
