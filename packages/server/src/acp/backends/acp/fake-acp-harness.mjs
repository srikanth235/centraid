#!/usr/bin/env node
// governance: allow-repo-hygiene file-size-limit (#567) one scripted JSON-RPC fixture covers the shared ACP lifecycle; splitting modes would duplicate protocol state and weaken cross-mode parity

import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write("fake-acp 1.0.0\n");
  process.exit(0);
}
const flag = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const has = (name) => argv.includes(`--${name}`);
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

function pickMcpServer(list) {
  const arr = list ?? [];
  return (
    arr.find((s) => s && s.type === "http") ??
    arr.find((s) => s && !s.type && s.command)
  );
}

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

const effortValues = () =>
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

const configOptions = () => [
  ...(noModelOption
    ? []
    : [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
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
          type: "select",
          currentValue: activeEffort,
          options: effortValues(),
        },
      ]),
];

const sessionModes = () => ({
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Manual" },
    { id: "bypassPermissions", name: "Bypass Permissions" },
  ],
});

process.on("SIGTERM", () => {});

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const respond = (id, result) => send({ jsonrpc: "2.0", id, result });
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
const update = (sessionId, _update) =>
  notify("session/update", { sessionId, update: _update });

let nextClientReqId = 1000;
const pendingClient = new Map();

async function requestPermission(sessionId, toolCallId) {
  const id = nextClientReqId++;
  const options = [
    { optionId: "allow", name: "Allow once", kind: "allow_once" },
    { optionId: "always", name: "Always allow", kind: "allow_always" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ];
  const done = new Promise((resolve) => {
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

let mcpServer;
let mcpReqId = 0;

async function mcpCall(method, params, { auth = true } = {}) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (auth) for (const h of mcpServer.headers) headers[h.name] = h.value;
  const res = await fetch(mcpServer.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++mcpReqId, method, params }),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function runVaultPrompt(reqId, sessionId) {
  const out = { sawServer: Boolean(mcpServer) };
  if (mcpServer) {
    out.serverName = mcpServer.name;
    out.url = mcpServer.url;

    out.unauthStatus = (
      await mcpCall("tools/list", {}, { auth: false })
    ).status;

    const init = await mcpCall("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "fake-mcp-client", version: "0.0.1" },
    });
    out.serverInfoName = init.body?.result?.serverInfo?.name ?? null;
    out.tools = (
      (await mcpCall("tools/list", {})).body?.result?.tools ?? []
    ).map((t) => t.name);

    if (mcpAnnounce) {
      update(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "mcp-1",
        title: "mcp__centraid__vault_sql",
        kind: "other",
        status: "pending",
      });
      await requestPermission(sessionId, "mcp-1");
    }

    const call = await mcpCall("tools/call", {
      name: "vault_sql",
      arguments: { sql: "SELECT 1" },
    });
    out.callText = call.body?.result?.content?.[0]?.text ?? null;
    out.callIsError = call.body?.result?.isError ?? null;

    if (mcpAnnounce) {
      update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "mcp-1",
        status: "completed",
        rawOutput: { ok: true },
      });
    }
  }
  if (vaultMarker) writeFileSync(vaultMarker, JSON.stringify(out));

  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "vault done" },
  });
  respond(reqId, { stopReason: "end_turn" });
}

const BLUEPRINT_INVOKE_PLAN = [
  {
    blueprint: "photos",
    command: "media.create_album",
    input: { title: "Harness parity album" },
  },
  {
    blueprint: "docs",
    command: "core.create_folder",
    input: { name: "Harness parity" },
  },
  {
    blueprint: "agenda",
    command: "schedule.propose_event",
    input: {
      summary: "Harness parity event",
      dtstart: "2026-08-03T09:00:00+05:30",
      dtend: "2026-08-03T09:30:00+05:30",
      start_tz: "Asia/Kolkata",
      end_tz: "Asia/Kolkata",
      calendar_id: "calendar-harness-parity",
    },
  },
  {
    blueprint: "tasks",
    command: "schedule.add_task",
    input: { title: "Harness parity task" },
  },
  {
    blueprint: "people",
    command: "people.add_person",
    input: { display_name: "Harness Parity", cadence_days: 30 },
  },
  {
    blueprint: "notes",
    command: "knowledge.create_note",
    input: {
      title: "Harness parity note",
      body_text: "Created through vault_invoke.",
      format: "plain",
    },
  },
  {
    blueprint: "tally",
    command: "tally.create_group",
    input: { name: "Harness parity", icon: "🧭", member_ids: [] },
  },
  {
    blueprint: "locker",
    command: "locker.purge_item",
    input: { item_id: "locker-harness-parity" },
  },
];

async function runVaultParityPrompt(reqId, sessionId) {
  const out = { sawServer: Boolean(mcpServer), tools: [], invocations: [] };
  if (mcpServer) {
    await mcpCall("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "fake-mcp-client", version: "0.0.1" },
    });
    out.tools = (
      (await mcpCall("tools/list", {})).body?.result?.tools ?? []
    ).map((tool) => tool.name);

    out.invocations = await Promise.all(
      BLUEPRINT_INVOKE_PLAN.map(async (planned) => {
        const response = await mcpCall("tools/call", {
          name: "vault_invoke",
          arguments: { command: planned.command, input: planned.input },
        });
        return {
          blueprint: planned.blueprint,
          command: planned.command,
          isError: response.body?.result?.isError ?? null,
          text: response.body?.result?.content?.[0]?.text ?? null,
        };
      })
    );
  }
  if (vaultMarker) writeFileSync(vaultMarker, JSON.stringify(out));
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "blueprint parity done" },
  });
  respond(reqId, { stopReason: "end_turn" });
}

async function runPrompt(reqId, sessionId) {
  if (mode === "vault") return runVaultPrompt(reqId, sessionId);
  if (mode === "vault-parity") return runVaultParityPrompt(reqId, sessionId);
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
  if (permMarker && outcome && outcome.outcome === "selected") {
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

let promptReqId;
let promptSessionId;

function handle(msg) {
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
          ? msg.result && msg.result.outcome
            ? msg.result.outcome
            : msg.result
          : { outcome: "cancelled" }
      );
    }
    return;
  }

  const { id, method, params } = msg;
  if (method === "initialize") {
    if (mode === "timeout") return;
    const sessionCapabilities = {};
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
      writeFileSync(mcpMarker, JSON.stringify(params?.mcpServers ?? null));
    mcpServer = pickMcpServer(params?.mcpServers);
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
    if (params?.configId === "model") {
      activeModel = String(params?.value);
      if (!effortValues().some((entry) => entry.value === activeEffort))
        activeEffort = "default";
    } else if (params?.configId === "effort") {
      activeEffort = String(params?.value);
    }
    if (configMarker)
      writeFileSync(configMarker, `${params?.configId}=${params?.value}`);
    if (!noConfigUpdate) {
      update(params?.sessionId ?? "sess-1", {
        sessionUpdate: "config_option_update",
        configOptions: configOptions(),
      });
    }
    respond(id, { configOptions: configOptions() });
    return;
  }
  if (method === "session/set_mode") {
    if (modeMarker) writeFileSync(modeMarker, String(params?.modeId));
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
      writeFileSync(mcpMarker, JSON.stringify(params?.mcpServers ?? null));
    mcpServer = pickMcpServer(params?.mcpServers);
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
      writeFileSync(mcpMarker, JSON.stringify(params?.mcpServers ?? null));
    mcpServer = pickMcpServer(params?.mcpServers);
    const sid = params?.sessionId ?? "sess-1";
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
      writeFileSync(promptMarker, JSON.stringify(params?.prompt ?? null));
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
    promptSessionId = params?.sessionId;
    void runPrompt(id, params?.sessionId);
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

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl = buffer.indexOf("\n");
  while (nl >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line.startsWith("{")) {
      try {
        handle(JSON.parse(line));
      } catch {
        // Intentionally empty.
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
