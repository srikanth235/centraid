#!/usr/bin/env node
/*
 * Scripted fake ACP agent — a test fixture, not shipped code.
 *
 * Speaks just enough of the Agent Client Protocol (JSON-RPC 2.0 over
 * newline-delimited stdio) to exercise `runAcpTurn`'s handshake, session
 * setup, streaming translation, permission round-trip, resume, and
 * cancellation paths. Behaviour is driven by argv flags so each test can
 * spawn it in a different mode:
 *
 *   --mode=normal   handshake → session/new → stream chunks + tool call +
 *                   permission request → end_turn
 *   --mode=resume   advertise loadSession; session/load replays history
 *                   (which the client must swallow) → stream → end_turn
 *   --mode=cancel   stream one chunk, then wait for session/cancel; write a
 *                   marker and reply stopReason=cancelled
 *   --mode=exit     exit(1) immediately (spawn/nonzero-exit failure path)
 *   --mode=vault    dial the loopback MCP server the client passed in
 *                   `mcpServers` — unauthenticated probe, initialize,
 *                   tools/list, tools/call — and report what happened
 *   --mode=auth     reject session/new with ACP's AUTH_REQUIRED (-32000)
 *
 *   --prompt-caps=a,b       advertise these promptCapabilities (image/audio/
 *                           embeddedContext); default is none
 *   --mcp-http              advertise mcpCapabilities.http
 *   --mcp-marker=<path>     write the `mcpServers` array seen at session/new
 *   --prompt-marker=<path>  write the `session/prompt` content blocks
 *   --vault-marker=<path>   write the --mode=vault findings as JSON
 *   --mcp-announce          in --mode=vault, also stream the MCP call as an
 *                           ACP tool_call (the double-render guard's input)
 *
 *   --perm-marker=<path>    write the chosen permission optionId here
 *   --cancel-marker=<path>  write a marker when session/cancel is observed
 *   --config-marker=<path>  write `<configId>=<value>` on session/set_config_option
 *   --mode-marker=<path>    write the modeId on session/set_mode
 *   --no-model-option       advertise NO model selector (config-option-less agent)
 *   --cost=<amount>         emit a usage_update carrying this cumulative cost
 *   --currency=<code>       ISO 4217 code for --cost (default USD)
 *   --env-marker=<path>     write selected env vars as JSON at startup
 *
 * The config-option / usage shapes below mirror `@agentclientprotocol/sdk`'s
 * generated schema: model values are CONCRETE ids under a `category: "model"`
 * select, `usage_update` carries only context used/size + cumulative cost, and
 * the token breakdown rides on the `session/prompt` RESULT.
 */

import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const has = (name) => argv.includes(`--${name}`);
const mode = flag('mode') ?? 'normal';
const permMarker = flag('perm-marker');
const cancelMarker = flag('cancel-marker');
const configMarker = flag('config-marker');
const modeMarker = flag('mode-marker');
const envMarker = flag('env-marker');
const noModelOption = has('no-model-option');
const cost = flag('cost');
const currency = flag('currency') ?? 'USD';
const mcpMarker = flag('mcp-marker');
const promptMarker = flag('prompt-marker');
const vaultMarker = flag('vault-marker');
const mcpAnnounce = has('mcp-announce');
const mcpHttp = has('mcp-http');
const promptCaps = Object.fromEntries(
  (flag('prompt-caps') ?? '')
    .split(',')
    .filter(Boolean)
    .map((c) => [c, true]),
);

if (envMarker) {
  writeFileSync(
    envMarker,
    JSON.stringify({
      INITIAL_AGENT_MODE: process.env.INITIAL_AGENT_MODE ?? null,
      CODEX_PATH: process.env.CODEX_PATH ?? null,
      CLAUDE_CODE_EXECUTABLE: process.env.CLAUDE_CODE_EXECUTABLE ?? null,
      IS_SANDBOX: process.env.IS_SANDBOX ?? null,
    }),
  );
}

if (mode === 'exit') process.exit(1);

/** A `session/new`/`session/load` config-option set shaped like the real schema. */
const configOptions = () =>
  noModelOption
    ? []
    : [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'fake-model-default',
          options: [
            { value: 'fake-model-default', name: 'Default' },
            { value: 'fake-opus-9-1', name: 'Most capable' },
          ],
        },
      ];

const sessionModes = () => ({
  currentModeId: 'default',
  availableModes: [
    { id: 'default', name: 'Manual' },
    { id: 'bypassPermissions', name: 'Bypass Permissions' },
  ],
});

// Ignore SIGTERM: teardown is driven by stdin end (below), so a buffered
// cancel line is always processed before we exit — makes cancel deterministic.
process.on('SIGTERM', () => {});

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const respond = (id, result) => send({ jsonrpc: '2.0', id, result });
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
const update = (sessionId, update) => notify('session/update', { sessionId, update });

let nextClientReqId = 1000;
const pendingClient = new Map();

async function requestPermission(sessionId, toolCallId) {
  const id = nextClientReqId++;
  const options = [
    { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
  ];
  const done = new Promise((resolve) => pendingClient.set(id, resolve));
  send({
    jsonrpc: '2.0',
    id,
    method: 'session/request_permission',
    params: { sessionId, toolCall: { toolCallId }, options },
  });
  return done;
}

// ---- MCP client (only used by --mode=vault) --------------------------------

/** The loopback vault MCP server the client advertised at session/new. */
let mcpServer;
let mcpReqId = 0;

async function mcpCall(method, params, { auth = true } = {}) {
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (auth) for (const h of mcpServer.headers) headers[h.name] = h.value;
  const res = await fetch(mcpServer.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++mcpReqId, method, params }),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/**
 * Exercise the vault MCP endpoint and report what happened. Everything is
 * driven by request/response round-trips, never by waiting a fixed time.
 */
async function runVaultPrompt(reqId, sessionId) {
  const out = { sawServer: Boolean(mcpServer) };
  if (mcpServer) {
    out.serverName = mcpServer.name;
    out.url = mcpServer.url;

    // A request with no bearer must be refused before anything else.
    out.unauthStatus = (await mcpCall('tools/list', {}, { auth: false })).status;

    const init = await mcpCall('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'fake-mcp-client', version: '0.0.1' },
    });
    out.serverInfoName = init.body?.result?.serverInfo?.name ?? null;
    out.tools = ((await mcpCall('tools/list', {})).body?.result?.tools ?? []).map((t) => t.name);

    if (mcpAnnounce) {
      // Announce the call the way an agent that surfaces MCP tools does…
      update(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'mcp-1',
        title: 'mcp__centraid__vault_sql',
        kind: 'other',
        status: 'pending',
      });
      // …and round-trip a request so the client has provably processed it
      // before the HTTP call lands (stdio is ordered; the reply proves it).
      await requestPermission(sessionId, 'mcp-1');
    }

    const call = await mcpCall('tools/call', {
      name: 'vault_sql',
      arguments: { sql: 'SELECT 1' },
    });
    out.callText = call.body?.result?.content?.[0]?.text ?? null;
    out.callIsError = call.body?.result?.isError ?? null;

    if (mcpAnnounce) {
      update(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'mcp-1',
        status: 'completed',
        rawOutput: { ok: true },
      });
    }
  }
  if (vaultMarker) writeFileSync(vaultMarker, JSON.stringify(out));

  update(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'vault done' },
  });
  respond(reqId, { stopReason: 'end_turn' });
}

async function runPrompt(reqId, sessionId) {
  if (mode === 'vault') return runVaultPrompt(reqId, sessionId);

  if (mode === 'cancel') {
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'partial' },
    });
    // Wait for session/cancel to drive the reply; do nothing else.
    return;
  }

  update(sessionId, {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'thinking' },
  });
  update(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Hello ' },
  });
  update(sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId: 't1',
    title: 'read_file',
    kind: 'read',
    status: 'pending',
    rawInput: { path: 'notes.txt' },
  });

  const outcome = await requestPermission(sessionId, 't1');
  if (permMarker && outcome && outcome.outcome === 'selected') {
    writeFileSync(permMarker, String(outcome.optionId));
  }

  update(sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 't1',
    status: 'completed',
    rawOutput: { ok: true },
  });
  update(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'world' },
  });

  // Per schema: context used/size, plus a CUMULATIVE cost. No tokens here.
  update(sessionId, {
    sessionUpdate: 'usage_update',
    used: 1234,
    size: 200000,
    ...(cost !== undefined ? { cost: { amount: Number(cost), currency } } : {}),
  });

  // The authoritative token breakdown rides on the prompt RESULT.
  respond(reqId, {
    stopReason: 'end_turn',
    usage: {
      totalTokens: 150,
      inputTokens: 100,
      outputTokens: 50,
      cachedReadTokens: 20,
      cachedWriteTokens: 5,
    },
  });
}

// In-flight prompt request id, so a later session/cancel can settle it.
let promptReqId;
let promptSessionId;

function handle(msg) {
  // Response to our client→agent request (permission).
  if (typeof msg.id === 'number' && msg.result !== undefined && !msg.method) {
    const resolve = pendingClient.get(msg.id);
    if (resolve) {
      pendingClient.delete(msg.id);
      resolve(msg.result && msg.result.outcome ? msg.result.outcome : msg.result);
    }
    return;
  }

  const { id, method, params } = msg;
  if (method === 'initialize') {
    respond(id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: mode === 'resume',
        promptCapabilities: promptCaps,
        mcpCapabilities: { http: mcpHttp, sse: false, acp: false },
      },
      agentInfo: { name: 'fake-acp', title: 'Fake ACP', version: '0.0.1' },
      authMethods: [],
    });
    return;
  }
  if (method === 'session/new') {
    if (mcpMarker) writeFileSync(mcpMarker, JSON.stringify(params?.mcpServers ?? null));
    mcpServer = (params?.mcpServers ?? []).find((s) => s.type === 'http');
    if (mode === 'auth') {
      // ACP's AUTH_REQUIRED — what 18 of the 31 registry agents answer until
      // their CLI has been signed in.
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: 'Authentication required' },
      });
      return;
    }
    respond(id, { sessionId: 'sess-1', configOptions: configOptions(), modes: sessionModes() });
    return;
  }
  if (method === 'session/set_config_option') {
    if (configMarker) writeFileSync(configMarker, `${params?.configId}=${params?.value}`);
    respond(id, { configOptions: configOptions() });
    return;
  }
  if (method === 'session/set_mode') {
    if (modeMarker) writeFileSync(modeMarker, String(params?.modeId));
    respond(id, {});
    return;
  }
  if (method === 'session/load') {
    if (mcpMarker) writeFileSync(mcpMarker, JSON.stringify(params?.mcpServers ?? null));
    mcpServer = (params?.mcpServers ?? []).find((s) => s.type === 'http');
    const sid = params?.sessionId ?? 'sess-1';
    // Replay history the client MUST swallow (promptStarted gate).
    update(sid, {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'HISTORY_USER' },
    });
    update(sid, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'HISTORY_AGENT' },
    });
    respond(id, { configOptions: configOptions(), modes: sessionModes() });
    return;
  }
  if (method === 'session/prompt') {
    if (promptMarker) writeFileSync(promptMarker, JSON.stringify(params?.prompt ?? null));
    promptReqId = id;
    promptSessionId = params?.sessionId;
    void runPrompt(id, params?.sessionId);
    return;
  }
  if (method === 'session/cancel') {
    if (cancelMarker) writeFileSync(cancelMarker, 'cancelled');
    if (promptReqId !== undefined) {
      respond(promptReqId, { stopReason: 'cancelled' });
      promptReqId = undefined;
    }
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl = buffer.indexOf('\n');
  while (nl >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line.startsWith('{')) {
      try {
        handle(JSON.parse(line));
      } catch {
        // ignore malformed line
      }
    }
    nl = buffer.indexOf('\n');
  }
});
// Client closed stdin → teardown. Exit cleanly so the parent's exit wait resolves.
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
void promptSessionId;
