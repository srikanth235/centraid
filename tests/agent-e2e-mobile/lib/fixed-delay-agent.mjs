#!/usr/bin/env node
// A FIXED-DELAY ACP AGENT for the mobile CI gateway (#890 follow-up).
//
// WHY THIS EXISTS. `tests/journeys.json` carries
// `sendToFirstToken` — the interval between tapping send in the Assistant and
// the first token appearing on screen, which is the most-felt latency in the
// product on a phone. It has been `unmeasured` with `probe: "NONE TODAY"`
// because the CI gateway has no model provider at all: no provider, no turn, no
// first token, nothing to time. This is that provider.
//
// WHY A FIXED DELAY RATHER THAN AN INSTANT REPLY. The budget must fence the
// interval THIS REPO OWNS — the app's send path, the Iroh hop, the gateway's
// turn dispatch, the renderer reaching first paint. A real provider's think time
// is not that, and an instant reply is not it either: a zero-latency stub makes
// the measurement hypersensitive to scheduling noise and, worse, exercises a
// code path no real turn takes (the first chunk arriving before the client has
// finished setting up its stream). A KNOWN, CONSTANT delay gives a measurement
// with a floor to subtract:
//
//     repo-owned dead time ≈ observed sendToFirstToken − FIRST_TOKEN_DELAY_MS
//
// The constant is deliberately exported through the env var below rather than
// hard-coded at the call site, so the flow that does the subtraction and the
// agent that produces the delay cannot drift apart.
//
// WHAT THIS IS NOT. Not a model, and not a fake of one. It answers one prompt
// shape with fixed text. It exists to make a LATENCY measurable, not to make an
// assistant journey meaningful — a flow that asserted on the content of these
// tokens would be asserting on this file, which is the "green while observing
// nothing" failure #890 was opened about.
//
// Speaks the subset of ACP (JSON-RPC 2.0 over newline-delimited stdio) that
// `packages/server/src/acp/backends/acp/backend.ts` drives for a plain turn.
// The richer scripted fixture for protocol-level tests is
// `packages/server/src/acp/backends/acp/fake-acp-harness.mjs`; this one is
// deliberately small because its only job is to be PREDICTABLE.

import { fileURLToPath } from "node:url";

/** Env var carrying the pre-first-token delay, read by the agent and the flow. */
export const FIRST_TOKEN_DELAY_ENV = "CENTRAID_STUB_FIRST_TOKEN_DELAY_MS";

/** Default delay. Long enough to dominate scheduler jitter, short enough that a
 *  journey paying it several times still fits a device budget. */
export const DEFAULT_FIRST_TOKEN_DELAY_MS = 250;

/** The tokens the stub streams, in order. Fixed so a transcript is derivable. */
export const STUB_CHUNKS = ["Reading ", "your ", "vault."];

/**
 * The gateway prefs that make this file the Assistant's provider.
 *
 * EXPORTED RATHER THAN WRITTEN INLINE IN ci-gateway.mjs so that the gateway and
 * the test asserting the launch plan read the SAME three values. A test holding
 * its own copy of them proves the shape resolves, not that the gateway uses that
 * shape — and would keep passing after a rename on the gateway side, which is
 * precisely the drift that makes a green suite meaningless.
 *
 * `binPath` is the node binary and the script rides in `extraArgs`, so the
 * script needs no executable bit — a fresh checkout on a CI runner does not
 * reliably carry one.
 */
export function stubHarnessPrefs() {
  return {
    // "Custom ACP agent": no npm adapter and no default binary, so `binPath`
    // is spawned directly. Any adapter-carrying kind would resolve a package
    // instead and never reach this file.
    "harness.kind": "acp",
    "harness.binPath": process.execPath,
    "harness.extraArgs": [
      fileURLToPath(new URL("fixed-delay-agent.mjs", import.meta.url)),
    ],
  };
}

/** Resolve the delay from an env bag, falling back to the default. */
export function resolveDelayMs(env = process.env) {
  const raw = env[FIRST_TOKEN_DELAY_ENV];
  // An EMPTY string is unset, not zero. `Number("")` is 0, so the obvious parse
  // would read `FOO=` — which is what an unset shell variable expands to in a
  // workflow `env:` block — as "no delay at all", silently turning the probe
  // into the zero-latency stub this file exists to avoid.
  if (raw === undefined || String(raw).trim() === "")
    return DEFAULT_FIRST_TOKEN_DELAY_MS;
  const parsed = Number(raw);
  // A malformed value falls back rather than throwing: this process is spawned
  // deep inside a gateway turn, where an exit here surfaces as an unrelated
  // "harness failed to spawn" and costs an hour of the wrong debugging.
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_FIRST_TOKEN_DELAY_MS;
}

/**
 * Handle one decoded JSON-RPC message.
 *
 * Split from the stdio plumbing so the protocol can be tested in-process
 * without spawning anything — see `fixed-delay-agent.test.mjs`.
 *
 * @param msg decoded request
 * @param io  `{ send, delayMs, sleep }`
 */
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
    // THE MEASURED INTERVAL STARTS BEFORE THIS AND ENDS AT THE FIRST CHUNK
    // BELOW. Everything the client does to get here — spawn, initialize,
    // session/new, prompt dispatch — is already spent; this sleep is the only
    // deliberate cost, and it is the one the flow subtracts.
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
    // A notification, not a request: no `id`, so nothing to answer. Accepting it
    // silently is correct; throwing would turn a cancelled journey into a
    // harness crash and mislabel the failure class in the run ledger.
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
        // Each message is handled without awaiting the previous one, so a slow
        // prompt does not block a cancel arriving behind it — which is exactly
        // the interleave `session/cancel` exists for.
        void handleMessage(JSON.parse(line), io);
      }
      newline = buffer.indexOf("\n");
    }
  });
  // Keep the process alive on an idle stdin; the client kills it when done.
  process.on("SIGTERM", () => process.exit(0));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
