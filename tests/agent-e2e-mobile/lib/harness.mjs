// governance: allow-repo-hygiene file-size-limit The #716 harness centralizes one simulator/gateway lifecycle; splitting it would duplicate cleanup and verdict invariants.

import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import {
  defaultRunId,
  writeFlowVerdict,
} from "../../agent-e2e-shared/harness.mjs";
import { purgeDemo, seedDemo } from "./demo-corpus.mjs";
import { classifyFailure, countMaestroAssertions } from "./failure-class.mjs";
import {
  DISMISS_KEYBOARD_ONBOARDING,
  retryableTapCommands,
} from "./first-run.mjs";
import { digestLines } from "./hierarchy-digest.mjs";
import {
  DEV_LAUNCHER_LINK,
  METRO_ORIGIN,
  METRO_PORT,
  prewarmMetroBundle,
  waitForMetroReachable,
} from "./metro.mjs";
import { appendRunRecord, ledgerPathFromEnv } from "./run-ledger.mjs";
import { spawnLive, spawnQuiet } from "./spawn.mjs";

const execFileAsync = promisify(execFile);

const __dirname = import.meta.dirname;
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const RUNS_DIR = path.join(__dirname, "..", "runs");

export const APP_ID = "dev.centraid.mobile";

export const BUILD_TYPE =
  process.env.CENTRAID_MOBILE_BUILD === "release" ? "release" : "dev";
export const IS_RELEASE_BUILD = BUILD_TYPE === "release";

const appIdForPlatform = (platform) =>
  platform === "android" && !IS_RELEASE_BUILD ? `${APP_ID}.debug` : APP_ID;

export const FIRST_LAUNCH_TIMEOUT_MS = IS_RELEASE_BUILD ? 45_000 : 120_000;

export function shQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}
export const HOME_READY_MARKER = "All apps and places";
export const HOME_LAUNCHER_HANDLE = "home-grid";
export const LAUNCHER_ARRIVAL_TIMEOUT_MS = 60_000;
export const AWAIT_LAUNCHER = `- extendedWaitUntil:
    visible:
      id: "${HOME_LAUNCHER_HANDLE}"
    timeout: ${LAUNCHER_ARRIVAL_TIMEOUT_MS}
`;
export const CONFIRM_SYSTEM_OPEN = `# iOS system confirmation for a custom-scheme openLink, then the dev-client
# first-run explainer — see CONFIRM_SYSTEM_OPEN.
- tapOn:
    text: "^Open$"
    optional: true
- tapOn:
    text: "^Continue$"
    optional: true
`;
const MAESTRO_CHUNK_TIMEOUT_MS = 12 * 60_000;

const MAESTRO_CHUNK_FLOOR_MS = 15_000;

export function maestroChunkTimeoutMs(now = Date.now()) {
  const deadline = Number(process.env.CENTRAID_MOBILE_DEADLINE_MS);
  if (!Number.isFinite(deadline) || deadline <= 0) {
    return MAESTRO_CHUNK_TIMEOUT_MS;
  }
  const remaining = deadline - now;
  if (remaining >= MAESTRO_CHUNK_TIMEOUT_MS) return MAESTRO_CHUNK_TIMEOUT_MS;
  return Math.max(MAESTRO_CHUNK_FLOOR_MS, remaining);
}

export const DEV_LAUNCHER_HANDOFF = IS_RELEASE_BUILD
  ? ""
  : `# clearState wiped the dev client's stored "last opened" URL, so the plain
# launch lands on the launcher's empty server picker. Hand it the bundle URL
# explicitly (DEV_LAUNCHER_LINK in lib/metro.mjs has the full story).
- openLink: "${DEV_LAUNCHER_LINK}"
${CONFIRM_SYSTEM_OPEN}`;

function spawnText(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("exit", (code) => {
      if (code === 0) resolve(out);
      else
        reject(
          new Error(`${cmd} ${args.join(" ")} exited ${code}: ${err || out}`)
        );
    });
    p.on("error", reject);
  });
}

async function bootedIosSim() {
  const out = await spawnText("xcrun", [
    "simctl",
    "list",
    "devices",
    "booted",
    "--json",
  ]);
  const data = JSON.parse(out);
  for (const list of Object.values(data.devices ?? {})) {
    for (const dev of list ?? []) {
      if (dev.state === "Booted") return dev.udid;
    }
  }
  return null;
}

async function bootedAndroidEmu() {
  try {
    const out = await spawnText("adb", ["devices"]);
    for (const line of out.split("\n").slice(1)) {
      const [serial, state] = line.split("\t");
      if (state?.trim() === "device" && serial) return serial.trim();
    }
  } catch {
    // Intentionally empty.
  }
  return null;
}

async function bootedDevice() {
  const force = process.env.MAESTRO_PLATFORM;
  if (force === "android") {
    const udid = await bootedAndroidEmu();
    return udid ? { udid, platform: "android" } : null;
  }
  if (force === "ios") {
    const udid = await bootedIosSim();
    return udid ? { udid, platform: "ios" } : null;
  }
  const ios = await bootedIosSim();
  if (ios) return { udid: ios, platform: "ios" };
  const android = await bootedAndroidEmu();
  if (android) return { udid: android, platform: "android" };
  return null;
}

async function appInstalled(device, appId) {
  if (device.platform === "ios") {
    try {
      await spawnText("xcrun", [
        "simctl",
        "get_app_container",
        device.udid,
        appId,
        "app",
      ]);
      return true;
    } catch {
      return false;
    }
  }
  try {
    const out = await spawnText("adb", [
      "-s",
      device.udid,
      "shell",
      "pm",
      "list",
      "packages",
      appId,
    ]);
    return out.includes(`package:${appId}`);
  } catch {
    return false;
  }
}

async function ensureMetroReverseForAndroid(udid) {
  await spawnText("adb", [
    "-s",
    udid,
    "reverse",
    `tcp:${METRO_PORT}`,
    `tcp:${METRO_PORT}`,
  ]);
}

export async function setup({ runId } = {}) {
  const device = await bootedDevice();
  if (!device) {
    throw new Error(
      "No booted iOS Simulator or Android emulator. For iOS: open Simulator.app " +
        "(or `xcrun simctl boot <udid>`) then `bun run --filter=@centraid/mobile ios`. " +
        "For Android: start an AVD via `emulator @<name>` (or Android Studio) then " +
        "`bun run --filter=@centraid/mobile android`. Set MAESTRO_PLATFORM=ios|android " +
        "to force a side when both are present."
    );
  }
  const appId = appIdForPlatform(device.platform);
  if (!(await appInstalled(device, appId))) {
    throw new Error(
      `${appId} not installed on ${device.platform} device ${device.udid}. ` +
        `Run \`bun run --filter=@centraid/mobile ${device.platform}\` first.`
    );
  }
  if (!IS_RELEASE_BUILD) {
    if (device.platform === "android") {
      await ensureMetroReverseForAndroid(device.udid);
    }
    if (!(await waitForMetroReachable())) {
      throw new Error(
        `Metro bundler not reachable at ${METRO_ORIGIN} after the bounded readiness wait. ` +
          "The dev build needs it to serve the JS bundle — start it with " +
          "`cd apps/mobile && bun expo start --dev-client`. (A CI lane should not " +
          "reach here at all: set CENTRAID_MOBILE_BUILD=release and drive the " +
          "artifact members install.)"
      );
    }
    await prewarmMetroBundle(device.platform, appId);
  }
  const id = runId ?? defaultRunId();
  const runDir = path.join(RUNS_DIR, id);
  const screenshotsDir = path.join(runDir, "screenshots");
  const flowsDir = path.join(runDir, "flows");
  await fs.mkdir(screenshotsDir, { recursive: true });
  await fs.mkdir(flowsDir, { recursive: true });

  const state = {
    runId: id,
    runDir,
    screenshotsDir,
    flowsDir,
    udid: device.udid,
    platform: device.platform,
    appId,
    buildType: BUILD_TYPE,
  };
  await fs.writeFile(
    path.join(runDir, "state.json"),
    JSON.stringify(state, null, 2)
  );
  return state;
}

const HIERARCHY_TIMEOUT_MS = 20_000;

const HIERARCHY_MAX_BYTES = 16 * 1024 * 1024;

async function captureHierarchy(udid) {
  try {
    const { stdout } = await execFileAsync(
      "maestro",
      ["--udid", udid, "hierarchy"],
      { maxBuffer: HIERARCHY_MAX_BYTES, timeout: HIERARCHY_TIMEOUT_MS }
    );
    return stdout;
  } catch {
    return undefined;
  }
}

const LOGCAT_TAIL_LINES = 4000;
const LOGCAT_DIGEST_LINES = 40;

const REPLICA_LOG_PATTERN =
  /replica|bootstrap|scope|vault|pull|sync|cursor|clone|undefined is not|Error|Exception/iu;

const DRIVER_NOISE_PATTERN = /\bMaestro\s*:/u;

async function printReplicaDigest(udid) {
  try {
    const { stdout } = await execFileAsync(
      "adb",
      ["-s", udid, "logcat", "-d", "-t", String(LOGCAT_TAIL_LINES)],
      { maxBuffer: HIERARCHY_MAX_BYTES, timeout: HIERARCHY_TIMEOUT_MS }
    );
    const kept = stdout
      .split("\n")
      .filter((line) => !DRIVER_NOISE_PATTERN.test(line))
      .filter((line) => /ReactNativeJS|ReactNative:|centraid/iu.test(line))
      .filter((line) => REPLICA_LOG_PATTERN.test(line));
    const seen = new Set();
    const lines = kept
      .filter((line) => {
        const message = line.replace(/^.*?\b[VDIWEF]\s+/u, "");
        if (seen.has(message)) return false;
        seen.add(message);
        return true;
      })
      .slice(-LOGCAT_DIGEST_LINES);
    if (lines.length === 0) {
      console.error("  the app logged nothing about the replica");
      return;
    }
    console.error("  the app logged:");
    for (const line of lines) console.error(`    ${line.trim()}`);
  } catch {
    // Intentionally empty.
  }
}

async function printScreenDigest(udid, debugDir) {
  try {
    const lines = digestLines(await captureHierarchy(udid));
    if (lines.length > 0) {
      console.error("  the screen carried:");
      for (const line of lines) console.error(`    ${line}`);
      return lines;
    }
    const names = await fs
      .readdir(debugDir, { recursive: true })
      .catch(() => []);
    console.error(
      `  no hierarchy from the device; ${path.basename(debugDir)} holds: ${
        names.slice(0, 20).join(", ") || "nothing"
      }`
    );
  } catch {
    // Intentionally empty.
  }
  return [];
}

async function runMaestroChunk(
  yaml,
  { state, label, maestroEnv = {}, sensitive = false }
) {
  const flowFile = path.join(state.flowsDir, `${label}.yaml`);
  const debugDir = path.join(state.runDir, "maestro-debug", label);
  await fs.writeFile(flowFile, yaml);
  const run = sensitive ? spawnQuiet : spawnLive;
  try {
    await run(
      "maestro",
      [
        "--udid",
        state.udid,
        "test",
        "--debug-output",
        debugDir,
        "--flatten-debug-output",
        flowFile,
      ],
      {
        cwd: state.screenshotsDir,
        env: { ...process.env, ...maestroEnv },
        secrets: Object.values(maestroEnv),
        timeoutMs: maestroChunkTimeoutMs(),
      }
    );
  } catch (error) {
    if (!sensitive && !label.includes("configure-gateway")) {
      const screen = await printScreenDigest(state.udid, debugDir);
      await printReplicaDigest(state.udid);
      if (error instanceof Error) error.screenDigest = screen.join("\n");
    }
    throw error;
  } finally {
    if (sensitive) await fs.rm(debugDir, { force: true, recursive: true });
  }
}

export function reusePairedCommands() {
  return `- launchApp:
    clearState: false
- extendedWaitUntil:
    visible: "${HOME_READY_MARKER}"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
`;
}

export function restartCommands() {
  return `- stopApp
- launchApp:
    clearState: false
`;
}

export function prependPrefix(prefix, yaml) {
  if (!prefix) return yaml;
  const separator = "\n---\n";
  const at = yaml.indexOf(separator);
  if (at === -1) {
    throw new Error(
      "cannot fold staged commands into a chunk with no `---` document separator"
    );
  }
  const head = at + separator.length;
  return `${yaml.slice(0, head)}${prefix}${yaml.slice(head)}`;
}

export async function runFlow(slug, fn) {
  const state = await setup({ runId: `${slug}-${defaultRunId()}` });
  console.log(`[runFlow] ${slug}`);
  console.log(`  run dir : ${path.relative(REPO_ROOT, state.runDir)}`);
  console.log(`  target  : ${state.platform} ${state.udid}`);

  let stepIdx = 0;
  const nextLabel = (hint) => {
    stepIdx += 1;
    const n = String(stepIdx).padStart(2, "0");
    return hint ? `${n}-${hint}` : `${n}-step`;
  };

  const notes = [];
  let assertionsRun = 0;
  let pendingPrefix = "";
  const pendingLabels = [];
  const run = async (yaml, hint, options = {}) => {
    const label = nextLabel(hint);
    console.log(`  run     : ${label}`);
    const chunk = prependPrefix(pendingPrefix, yaml);
    pendingPrefix = "";
    pendingLabels.length = 0;
    await runMaestroChunk(chunk, { state, label, ...options });
    assertionsRun += countMaestroAssertions(chunk);
  };
  const stagePrefix = (commands, label) => {
    pendingPrefix += commands;
    pendingLabels.push(label);
    console.log(`  prefix  : ${label} folded into the next chunk`);
  };
  const flushPrefix = async () => {
    if (!pendingPrefix) return;
    await run(`appId: ${state.appId}\n---\n`, pendingLabels.join("-"));
  };
  const device = async (args, { label } = {}) => {
    await flushPrefix();
    const hint = label ?? args[0] ?? "device";
    console.log(`  device  : ${hint}`);
    if (state.platform === "android")
      return spawnText("adb", ["-s", state.udid, ...args]);
    return spawnText("xcrun", [
      "simctl",
      args[0],
      state.udid,
      ...args.slice(1),
    ]);
  };

  const ctx = {
    state,
    note(m) {
      notes.push(m);
      console.log(`  note    : ${m}`);
    },
    run,
    device,
    flush: flushPrefix,
  };

  const mintPairingTicket = async (gatewayUrl, gatewayToken) => {
    const dataDir = process.env.MAESTRO_GATEWAY_DATA_DIR;
    if (dataDir) {
      const cli = path.join(REPO_ROOT, "packages/server/dist/cli/cli.js");
      const port = new URL(gatewayUrl).port;
      const pairEnv = gatewayToken
        ? { env: { ...process.env, CENTRAID_GATEWAY_TOKEN: gatewayToken } }
        : {};
      const out = await spawnText(
        "node",
        [
          cli,
          "pair",
          "--data-dir",
          dataDir,
          ...(port ? ["--port", port] : []),
          "--ttl-minutes",
          "30",
          "--json",
        ],
        pairEnv
      );
      const line = out.trim().split("\n").at(-1);
      const parsed = JSON.parse(line ?? "{}");
      if (parsed.ok !== true || typeof parsed.ticket !== "string") {
        throw new Error(
          `centraid-gateway pair refused a mobile ticket (${parsed.error ?? "no ticket"})`
        );
      }
      return parsed.ticket;
    }
    const ticketResponse = await fetch(
      `${gatewayUrl.replace(/\/+$/u, "")}/centraid/_gateway/devices/ticket`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(gatewayToken ? { authorization: `Bearer ${gatewayToken}` } : {}),
        },
        body: JSON.stringify({
          ttlMinutes: 15,
        }),
      }
    );
    const ticketResult = await ticketResponse.json().catch(() => ({}));
    if (
      !ticketResponse.ok ||
      ticketResult?.ok !== true ||
      typeof ticketResult.ticket !== "string"
    ) {
      throw new Error(
        `gateway refused mobile pairing ticket (${ticketResult?.error ?? ticketResponse.status})`
      );
    }
    return ticketResult.ticket;
  };

  ctx.configureGateway = async (
    gatewayUrl = process.env.MAESTRO_GATEWAY_URL,
    gatewayToken = process.env.MAESTRO_GATEWAY_TOKEN ?? ""
  ) => {
    if (!gatewayUrl) {
      throw new Error(
        "MAESTRO_GATEWAY_URL is required for this mobile journey"
      );
    }
    if (process.env.MAESTRO_REUSE_PAIRED_STATE === "1") {
      stagePrefix(reusePairedCommands(), "reuse-paired-gateway");
      ctx.note(`reused the paired nightly profile for ${gatewayUrl}`);
      return;
    }
    const pairingTicket = await mintPairingTicket(gatewayUrl, gatewayToken);

    await ctx.run(
      `appId: ${state.appId}
---
- launchApp:
    clearState: true
${DEV_LAUNCHER_HANDOFF}- extendedWaitUntil:
    visible:
      text: "Connect your gateway."
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- tapOn: "Can't scan? Paste a code instead"
- extendedWaitUntil:
    visible: "Paste the one-line ticket"
    timeout: 10000
`,
      "open-onboarding"
    );

    await ctx.run(
      `appId: ${state.appId}
---
- tapOn: "Paste the one-line ticket"
# e2e-lint-allow: unasserted-input — throwaway input only provokes iOS keyboard
# onboarding and is erased before the pairing ticket is entered.
- inputText: "x"
${DISMISS_KEYBOARD_ONBOARDING}- eraseText
# e2e-lint-allow: unasserted-input — Maestro cannot reliably match long
# long React Native TextInput values; successful redemption below is the
# end-to-end observation of the one-time ticket. MAESTRO_* shell variables are
# resolved by Maestro without persisting the live capability in this YAML.
- inputText: \${MAESTRO_PAIRING_TICKET}
- hideKeyboard
# The ticket is deliberately a one-line field, so its stable native Pressable
# remains in the viewport even while the iOS keyboard is still visible.
- tapOn:
    id: "onboarding-connect"
# Redemption dials the gateway over iroh; on a cold simulator that handshake is
# the slowest step in the journey, so budget for the network, not the render.
- extendedWaitUntil:
    visible: "Who's using this phone[?]|You're all set, [^.]+[.]"
    timeout: 90000
`,
      "configure-gateway",
      {
        maestroEnv: { MAESTRO_PAIRING_TICKET: pairingTicket },
        sensitive: true,
      }
    );

    await ctx.run(
      `appId: ${state.appId}
---
- runFlow:
    when:
      visible: "Who's using this phone[?]"
    commands:
      - tapOn: "Your name"
# e2e-lint-allow: unasserted-input — React Native TextInput values are not
# reliably Maestro-matchable; the personalized done heading below proves the
# submitted profile name end to end.
      - inputText: "Nightly"
      - hideKeyboard
      - tapOn: "Continue"
- extendedWaitUntil:
    visible: "You're all set, [^.]+[.]"
    timeout: 60000
# iOS can acknowledge an accessibility tap before the RN Pressable is ready.
# The button's press animation changes the hierarchy even if navigation was
# ignored, so retry only while the source control remains visible. The Home
# marker below remains mandatory and prevents a vacuous pass.
${retryableTapCommands("Enter Centraid")}
# The rail remains visible while Home loads, and the async Daily Brief can move
# every tile when it arrives. Wait for its explicit settled accessibility label
# so the next tap never uses coordinates captured before that layout shift.
- extendedWaitUntil:
    visible: "${HOME_READY_MARKER}"
    timeout: 30000
`,
      "complete-onboarding"
    );
    ctx.note(`paired the journey with the gateway at ${gatewayUrl}`);
  };

  ctx.ensureDemo = async (
    appId,
    gatewayUrl = process.env.MAESTRO_GATEWAY_URL,
    gatewayToken = process.env.MAESTRO_GATEWAY_TOKEN ?? ""
  ) => {
    const result = await seedDemo(appId, gatewayUrl, gatewayToken);
    ctx.note(
      result.seeded
        ? `${appId} demo seeded (${result.rows} rows)`
        : `${appId} demo already present (${result.rows} rows)`
    );
  };

  ctx.purgeDemo = async (
    appId,
    gatewayUrl = process.env.MAESTRO_GATEWAY_URL,
    gatewayToken = process.env.MAESTRO_GATEWAY_TOKEN ?? ""
  ) => {
    const result = await purgeDemo(appId, gatewayUrl, gatewayToken);
    ctx.note(`${appId} demo purged (${result.purged} rows)`);
  };

  ctx.restart = async () => {
    console.log("  restart …");
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
    stagePrefix(restartCommands(), "restart");
  };

  let error;
  let result;
  const t0 = Date.now();
  const startedAt = new Date(t0).toISOString();
  try {
    result = await fn(ctx);
  } catch (caughtError) {
    error = caughtError;
  }
  try {
    await flushPrefix();
  } catch (flushError) {
    error ??= flushError;
  }
  const elapsedMs = Date.now() - t0;
  const pass = !error && result?.pass !== false;

  const owner = path
    .relative(REPO_ROOT, path.resolve(process.argv[1] ?? ""))
    .split(path.sep)
    .join("/");

  await writeFlowVerdict({
    repoRoot: REPO_ROOT,
    slug,
    runDir: state.runDir,
    elapsedMs,
    error,
    notes,
    result,
    metadata: { platform: state.platform, udid: state.udid, app: state.appId },
    debug:
      "Maestro keeps per-step screenshots and ai-report.html under `~/.maestro/tests/<timestamp>/`; the newest directory belongs to this run.",
    owner,
  });

  const failure = pass
    ? null
    : classifyFailure({
        error,
        assertionsRun,
        stdout: error?.screenDigest ?? "",
      });
  try {
    await appendRunRecord({
      flow: owner,
      slug,
      platform: state.platform,
      device: state.udid,
      startedAt,
      durationMs: elapsedMs,
      pass,
      failureClass: failure?.class ?? null,
      failureReason: failure ? `${failure.signal}: ${failure.reason}` : "",
      lane: process.env.CENTRAID_MOBILE_LANE ?? "local",
      runId: state.runId,
      commit: process.env.GITHUB_SHA ?? "",
    });
  } catch (ledgerError) {
    console.warn(
      `  ledger  : could not append to ${ledgerPathFromEnv()} — ${ledgerError.message}`
    );
  }

  if (!pass) {
    if (error) console.error(error);
    process.exit(1);
  }
}

const cmd = process.argv[2];
if (cmd) {
  try {
    let out;
    if (cmd === "setup") out = await setup();
    else if (cmd === "list-devices") out = await bootedDevice();
    else {
      console.error(`unknown command: ${cmd}`);
      process.exit(1);
    }
    console.log(JSON.stringify(out, null, 2));
  } catch (error) {
    console.error(error.message ?? error);
    process.exit(1);
  }
}
