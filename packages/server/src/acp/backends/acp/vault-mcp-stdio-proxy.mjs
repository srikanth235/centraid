#!/usr/bin/env node

import { createInterface } from "node:readline";

const url = process.env.CENTRAID_VAULT_MCP_URL;
const token = process.env.CENTRAID_VAULT_MCP_TOKEN;

if (!url || !token) {
  process.stderr.write(
    "vault-mcp-stdio-proxy: CENTRAID_VAULT_MCP_URL and TOKEN required\n"
  );
  process.exit(2);
}

const send = (msg) => {
  process.stdout.write(JSON.stringify(msg) + "\n");
};

async function forward(body) {
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
    return JSON.parse(text);
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
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (msg.method && msg.id === undefined) {
    void forward(msg).catch(() => undefined);
    return;
  }
  if (msg.method && msg.id !== undefined) {
    void forward(msg)
      .then((out) => {
        if (out && typeof out === "object") send(out);
      })
      .catch((error) => {
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
