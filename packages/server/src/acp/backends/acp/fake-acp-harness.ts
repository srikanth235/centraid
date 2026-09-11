#!/usr/bin/env node
/*
 * Scripted fake ACP harness — a test fixture, not shipped code.
 * JSON-RPC 2.0 over newline-delimited stdio. Argv `--mode=` and marker
 * flags select handshake, stream, permission, resume, vault MCP, and
 * failure paths used by the ACP backend suite.
 */

import { writeFileSync } from "node:fs";

import { createVaultSession } from "./fake-acp-harness-vault.ts";

interface JsonRpcMessage {
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface SelectOption {
  value: string;
  name: string;
}

interface ConfigOption {
  id: string;
  name: string;
  category: string;
  type: "select";
  currentValue: string;
  options: SelectOption[];
}

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write("fake-acp 1.0.0\n");
  process.exit(0);
}
const flag = (name: string): string | undefined => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const has = (name: string): boolean => argv.includes(`--${name}`);
const mode = flag("mode") ?? "normal";
const permMarker = flag("perm-marker");
const cancelMarker = flag("cancel-marker");
const configMarker = flag("config-marker");
const modeMarker = flag("mode-marker");
const envMarker = flag("env-marker");
const noModelOption = has("no-model-option");
const noEffortOption = has("no-effort-option");
const noUsageUpdate = has("no-usage-update");
const noLocations = has("no-locations");
const noConfigUpdate = has("no-config-update");
const midturnModel = flag("midturn-model");
const midturnDropEffort = has("midturn-drop-effort");
const ignoreStdinEnd = has("ignore-stdin-end");
const cost = flag("cost");
const currency = flag("currency") ?? "USD";
const mcpMarker = flag("mcp-marker");
const promptMarker = flag("prompt-marker");
const vaultMarker = flag("vault-marker");
const mcpAnnounce = has("mcp-announce");
const mcpHttp = has("mcp-http");
const sessionResume = has("session-resume") || mode === "resume-cap";
const failResume = has("fail-resume");
const sessionClose = has("session-close");
const sessionAddlDirs = has("session-addl-dirs");
const pidMarker = flag("pid-marker");
const promptCaps = Object.fromEntries(
  (flag("prompt-caps") ?? "")
    .split(",")
    .filter(Boolean)
    .map((c) => [c, true])
);

if (envMarker) {
  writeFileSync(
    envMarker,
    JSON.stringify({
      INITIAL_AGENT_MODE: process.env.INITIAL_AGENT_MODE ?? null,
      CODEX_PATH: process.env.CODEX_PATH ?? null,
      CLAUDE_CODE_EXECUTABLE: process.env.CLAUDE_CODE_EXECUTABLE ?? null,
      IS_SANDBOX: process.env.IS_SANDBOX ?? null,
    })
  );
}

if (pidMarker) writeFileSync(pidMarker, String(process.pid));

if (mode === "exit") process.exit(1);

let activeModel = "fake-model-default";
let activeEffort = "default";

const effortValues = (): SelectOption[] =>
  activeModel === "fake-opus-9-1"
    ? [
        { value: "default", name: "Default" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ]
    : [
        { value: "default", name: "Default" },
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
      ];

/** A `session/new`/`session/load` config-option set shaped like the real schema. */
const configOptions = (): ConfigOption[] => [
  ...(noModelOption
    ? []
    : [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select" as const,
          currentValue: activeModel,
          options: [
            { value: "fake-model-default", name: "Default" },
            { value: "fake-opus-9-1", name: "Most capable" },
          ],
        },
      ]),
  ...(noEffortOption
    ? []
    : [
        {
          id: "effort",
          name: "Effort",
          category: "thought_level",
          type: "select" as const,
          currentValue: activeEffort,
          options: effortValues(),
        },
      ]),
];

const sessionModes = (): {
  currentModeId: string;
  availableModes: { id: string; name: string }[];
} => ({
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Manual" },
    { id: "bypassPermissions", name: "Bypass Permissions" },
  ],
});

// Ignore SIGTERM: teardown is driven by stdin end (below), so a buffered
// cancel line is always processed before we exit — makes cancel deterministic.
process.on("SIGTERM", () => {});

const send = (msg: unknown): void => {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
};
const respond = (
  id: string | number | null | undefined,
  result: unknown
): void => send({ jsonrpc: "2.0", id, result });
const notify = (method: string, params: unknown): void =>
  send({ jsonrpc: "2.0", method, params });
const update = (sessionId: string, payload: Record<string, unknown>): void =>
  notify("session/update", { sessionId, update: payload });

let nextClientReqId = 1000;
const pendingClient = new Map<number, (value: unknown) => void>();

async function requestPermission(
  sessionId: string,
  toolCallId: string
): Promise<unknown> {
  const id = nextClientReqId++;
  const options = [
    { optionId: "allow", name: "Allow once", kind: "allow_once" },
    { optionId: "always", name: "Always allow", kind: "allow_always" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ];
  const done = new Promise<unknown>((resolve) => {
    pendingClient.set(id, resolve);
  });
  send({
    jsonrpc: "2.0",
    id,
    method: "session/request_permission",
    params: { sessionId, toolCall: { toolCallId }, options },
  });
  return done;
}

const vault = createVaultSession({
  io: { update, respond, requestPermission },
  vaultMarker,
  mcpAnnounce,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function permissionOutcome(result: unknown): unknown {
  if (!isRecord(result) || !("outcome" in result)) return result;
  return result.outcome;
}

function paramString(params: unknown, key: string): string | undefined {
  if (!isRecord(params) || typeof params[key] !== "string") return undefined;
  return params[key];
}

async function runPrompt(
  reqId: string | number | null | undefined,
  sessionId: string
): Promise<void> {
  if (mode === "vault") return vault.runVaultPrompt(reqId, sessionId);
  if (mode === "vault-parity")
    return vault.runVaultParityPrompt(reqId, sessionId);
  if (mode === "wedge") return;
  if (mode === "crash") process.exit(2);

  if (mode === "cancel") {
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "partial" },
    });
    return;
  }

  if (mode === "refusal") {
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "I cannot help with that." },
    });
    respond(reqId, { stopReason: "refusal" });
    return;
  }

  if (mode === "max_tokens") {
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "truncated reply" },
    });
    respond(reqId, {
      stopReason: "max_tokens",
      usage: { totalTokens: 10, inputTokens: 5, outputTokens: 5 },
    });
    return;
  }

  update(sessionId, {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "thinking" },
  });
  update(sessionId, {
    sessionUpdate: "plan",
    entries: [
      { content: "Read notes", status: "completed", priority: "high" },
      { content: "Reply", status: "pending", priority: "medium" },
    ],
  });
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Hello " },
  });
  update(sessionId, {
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    title: "read_file",
    kind: "read",
    status: "pending",
    rawInput: { path: "notes.txt" },
  });

  const outcome = await requestPermission(sessionId, "t1");
  if (permMarker && isRecord(outcome) && outcome.outcome === "selected") {
    writeFileSync(permMarker, String(outcome.optionId));
  }

  update(sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: "t1",
    status: "completed",
    content: [
      {
        type: "diff",
        path: "notes.txt",
        oldText: "a",
        newText: "b",
      },
      {
        type: "content",
        content: { type: "text", text: "notes updated" },
      },
      {
        type: "terminal",
        terminalId: "term-1",
      },
    ],
    ...(noLocations ? {} : { locations: [{ path: "notes.txt", line: 1 }] }),
    rawOutput: { ok: true },
  });
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "world" },
  });

  if (midturnModel !== undefined || midturnDropEffort) {
    if (midturnModel !== undefined) activeModel = midturnModel;
    update(sessionId, {
      sessionUpdate: "config_option_update",
      configOptions: midturnDropEffort
        ? configOptions().filter(
            (option) => option.category !== "thought_level"
          )
        : configOptions(),
    });
  }

  if (!noUsageUpdate) {
    update(sessionId, {
      sessionUpdate: "usage_update",
      used: 1234,
      size: 200000,
      ...(cost === undefined
        ? {}
        : { cost: { amount: Number(cost), currency } }),
    });
  }

  respond(reqId, {
    stopReason: "end_turn",
    usage: {
      totalTokens: 150,
      inputTokens: 100,
      outputTokens: 50,
      cachedReadTokens: 20,
      cachedWriteTokens: 5,
    },
  });
}

let promptReqId: string | number | null | undefined;
let promptSessionId: string | undefined;

function handle(msg: JsonRpcMessage): void {
  if (
    typeof msg.id === "number" &&
    (msg.result !== undefined || msg.error !== undefined) &&
    !msg.method
  ) {
    const resolve = pendingClient.get(msg.id);
    if (resolve) {
      pendingClient.delete(msg.id);
      resolve(
        msg.error === undefined
          ? permissionOutcome(msg.result)
          : { outcome: "cancelled" }
      );
    }
    return;
  }

  const { id, method, params } = msg;
  if (method === "initialize") {
    if (mode === "timeout") return;
    const sessionCapabilities: Record<string, Record<string, never>> = {};
    if (sessionResume) sessionCapabilities.resume = {};
    if (sessionClose) sessionCapabilities.close = {};
    if (sessionAddlDirs) sessionCapabilities.additionalDirectories = {};
    respond(id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: mode === "resume" || mode === "resume-cap",
        promptCapabilities: promptCaps,
        mcpCapabilities: { http: mcpHttp, sse: false, acp: false },
        ...(Object.keys(sessionCapabilities).length
          ? { sessionCapabilities }
          : {}),
      },
      agentInfo: { name: "fake-acp", title: "Fake ACP", version: "0.0.1" },
      authMethods: [],
    });
    return;
  }
  if (method === "session/new") {
    if (mcpMarker)
      writeFileSync(
        mcpMarker,
        JSON.stringify(isRecord(params) ? (params.mcpServers ?? null) : null)
      );
    vault.setMcpServers(isRecord(params) ? params.mcpServers : undefined);
    if (mode === "auth") {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: "Authentication required" },
      });
      return;
    }
    if (mode === "quota") {
      send({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32029,
          message: "Rate limit exceeded; quota resets later",
        },
      });
      return;
    }
    respond(id, {
      sessionId: "sess-1",
      configOptions: configOptions(),
      modes: sessionModes(),
    });
    return;
  }
  if (method === "session/set_config_option") {
    const configId = paramString(params, "configId");
    if (configId === "model") {
      activeModel = String(isRecord(params) ? params.value : "");
      if (!effortValues().some((entry) => entry.value === activeEffort))
        activeEffort = "default";
    } else if (configId === "effort") {
      activeEffort = String(isRecord(params) ? params.value : "");
    }
    if (configMarker)
      writeFileSync(
        configMarker,
        `${paramString(params, "configId")}=${isRecord(params) ? String(params.value) : ""}`
      );
    if (!noConfigUpdate) {
      update(paramString(params, "sessionId") ?? "sess-1", {
        sessionUpdate: "config_option_update",
        configOptions: configOptions(),
      });
    }
    respond(id, { configOptions: configOptions() });
    return;
  }
  if (method === "session/set_mode") {
    if (modeMarker)
      writeFileSync(modeMarker, String(paramString(params, "modeId")));
    respond(id, {});
    return;
  }
  if (method === "session/resume") {
    if (failResume) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32001, message: "resume handle expired" },
      });
      return;
    }
    if (mcpMarker)
      writeFileSync(
        mcpMarker,
        JSON.stringify(isRecord(params) ? (params.mcpServers ?? null) : null)
      );
    vault.setMcpServers(isRecord(params) ? params.mcpServers : undefined);
    respond(id, { configOptions: configOptions(), modes: sessionModes() });
    return;
  }
  if (method === "session/close") {
    respond(id, {});
    return;
  }
  if (method === "session/load") {
    if (failResume) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32001, message: "load handle expired" },
      });
      return;
    }
    if (mcpMarker)
      writeFileSync(
        mcpMarker,
        JSON.stringify(isRecord(params) ? (params.mcpServers ?? null) : null)
      );
    vault.setMcpServers(isRecord(params) ? params.mcpServers : undefined);
    const sid = paramString(params, "sessionId") ?? "sess-1";
    update(sid, {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "HISTORY_USER" },
    });
    update(sid, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "HISTORY_AGENT" },
    });
    respond(id, { configOptions: configOptions(), modes: sessionModes() });
    return;
  }
  if (method === "session/prompt") {
    if (promptMarker)
      writeFileSync(
        promptMarker,
        JSON.stringify(isRecord(params) ? (params.prompt ?? null) : null)
      );
    if (mode === "auth-prompt") {
      send({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: "Failed to authenticate: OAuth session expired",
        },
      });
      return;
    }
    promptReqId = id;
    promptSessionId = paramString(params, "sessionId");
    void runPrompt(id, paramString(params, "sessionId") ?? "sess-1");
    return;
  }
  if (method === "session/cancel") {
    if (cancelMarker) writeFileSync(cancelMarker, "cancelled");
    if (promptReqId !== undefined) {
      respond(promptReqId, {
        stopReason: "cancelled",
        usage: { totalTokens: 150, inputTokens: 100, outputTokens: 50 },
      });
      promptReqId = undefined;
    }
  }
}

function asMessage(value: unknown): JsonRpcMessage | undefined {
  if (!isRecord(value)) return undefined;
  return value;
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let nl = buffer.indexOf("\n");
  while (nl >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line.startsWith("{")) {
      try {
        const msg = asMessage(JSON.parse(line) as unknown);
        if (msg) handle(msg);
      } catch {
        // ignore malformed line
      }
    }
    nl = buffer.indexOf("\n");
  }
});
if (ignoreStdinEnd) {
  setInterval(() => {}, 1000);
} else {
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
}
void promptSessionId;
