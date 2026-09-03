#!/usr/bin/env node

import { fileURLToPath } from "node:url";

export const FIRST_TOKEN_DELAY_ENV = "CENTRAID_STUB_FIRST_TOKEN_DELAY_MS";

export const DEFAULT_FIRST_TOKEN_DELAY_MS = 250;

export const STUB_CHUNKS = ["Reading ", "your ", "vault."];

export function stubHarnessPrefs() {
  return {
    "harness.kind": "acp",
    "harness.binPath": process.execPath,
    "harness.extraArgs": [
      fileURLToPath(new URL("fixed-delay-agent.mjs", import.meta.url)),
    ],
  };
}

export function resolveDelayMs(env = process.env) {
  const raw = env[FIRST_TOKEN_DELAY_ENV];
  if (raw === undefined || String(raw).trim() === "")
    return DEFAULT_FIRST_TOKEN_DELAY_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_FIRST_TOKEN_DELAY_MS;
}

export async function handleMessage(msg, io) {
  const { id, method, params } = msg;
  const send = io.send;
  const respond = (result) => send({ jsonrpc: "2.0", id, result });

  if (method === "initialize") {
    respond({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {},
        mcpCapabilities: { http: false, sse: false, acp: false },
      },
      agentInfo: {
        name: "centraid-fixed-delay",
        title: "Centraid fixed-delay stub",
        version: "1.0.0",
      },
      authMethods: [],
    });
    return;
  }

  if (method === "session/new") {
    respond({ sessionId: "mobile-ci-1" });
    return;
  }

  if (method === "session/prompt") {
    const sessionId = params?.sessionId ?? "mobile-ci-1";
    await io.sleep(io.delayMs);
    for (const text of STUB_CHUNKS) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        },
      });
    }
    respond({ stopReason: "end_turn" });
    return;
  }

  if (method === "session/cancel") {
    return;
  }

  if (id !== undefined) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32_601, message: `unsupported method: ${method}` },
    });
  }
}

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--version")) {
    process.stdout.write("centraid-fixed-delay 1.0.0\n");
    return;
  }

  const io = {
    send: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
    delayMs: resolveDelayMs(),
    sleep,
  };

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        void handleMessage(JSON.parse(line), io);
      }
      newline = buffer.indexOf("\n");
    }
  });
  process.on("SIGTERM", () => process.exit(0));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
