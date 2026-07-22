#!/usr/bin/env node
/*
 * Stdio MCP proxy for agents that only support stdio MCP transports.
 *
 * Centraid's vault tools live as a loopback HTTP MCP server (per-turn bearer).
 * Agents that lack `mcpCapabilities.http` can still spawn this process via
 * ACP's default stdio MCP shape; we forward initialize / tools/list /
 * tools/call / ping to the HTTP endpoint named in env:
 *
 *   CENTRAID_VAULT_MCP_URL   — e.g. http://127.0.0.1:PORT/mcp
 *   CENTRAID_VAULT_MCP_TOKEN — bearer token for Authorization
 *
 * Not a public API — launched only by the ACP turn backend.
 */

import { createInterface } from 'node:readline';

const url = process.env.CENTRAID_VAULT_MCP_URL;
const token = process.env.CENTRAID_VAULT_MCP_TOKEN;

if (!url || !token) {
  process.stderr.write('vault-mcp-stdio-proxy: CENTRAID_VAULT_MCP_URL and TOKEN required\n');
  process.exit(2);
}

const send = (msg) => {
  process.stdout.write(JSON.stringify(msg) + '\n');
};

async function forward(body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return {
      jsonrpc: '2.0',
      id: body.id ?? null,
      error: { code: -32000, message: `upstream HTTP ${res.status}: ${text.slice(0, 200)}` },
    };
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  // Notifications: forward fire-and-forget (no response expected).
  if (msg.method && msg.id === undefined) {
    void forward(msg).catch(() => undefined);
    return;
  }
  if (msg.method && msg.id !== undefined) {
    void forward(msg)
      .then((out) => {
        if (out && typeof out === 'object') send(out);
      })
      .catch((err) => {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          error: {
            code: -32000,
            message: err instanceof Error ? err.message : String(err),
          },
        });
      });
  }
});
