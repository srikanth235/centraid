// Mobile agent-e2e harness. One entry point — `runFlow` — handles setup
// (run dir, sim discovery, app-install check), provides a `ctx` surface to
// the flow body (run / restart / note), and writes a verdict.md at the end.
import { spawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import path from "node:path";

import {
  defaultRunId,
  writeFlowVerdict,
} from "../../agent-e2e-shared/harness.ts";
import type { FlowResult } from "../../agent-e2e-shared/harness.ts";
import { purgeDemo, seedDemo } from "./demo-corpus.ts";
import { classifyFailure, countMaestroAssertions } from "./failure-class.ts";
import {
  DISMISS_KEYBOARD_ONBOARDING,
  retryableTapCommands,
} from "./first-run.ts";
import {
  prependPrefix,
  restartCommands,
  reusePairedCommands,
  runMaestroChunk,
} from "./harness-maestro.ts";
import { bootedDevice, setup } from "./harness-setup.ts";
import {
  DEV_LAUNCHER_HANDOFF,
  FIRST_LAUNCH_TIMEOUT_MS,
  HOME_READY_MARKER,
} from "./harness-surface.ts";
import type { MaestroRunOptions, MobileFlowCtx } from "./harness-surface.ts";
import { appendRunRecord, ledgerPathFromEnv } from "./run-ledger.ts";

export {
  APP_ID,
  AWAIT_LAUNCHER,
  BUILD_TYPE,
  CONFIRM_SYSTEM_OPEN,
  DEV_LAUNCHER_HANDOFF,
  FIRST_LAUNCH_TIMEOUT_MS,
  HOME_LAUNCHER_HANDLE,
  HOME_READY_MARKER,
  IS_RELEASE_BUILD,
  LAUNCHER_ARRIVAL_TIMEOUT_MS,
  maestroChunkTimeoutMs,
  shQuote,
} from "./harness-surface.ts";
export type {
  MaestroRunOptions,
  MobileFlowCtx,
  MobileRunState,
} from "./harness-surface.ts";
export { setup } from "./harness-setup.ts";
export {
  prependPrefix,
  restartCommands,
  reusePairedCommands,
} from "./harness-maestro.ts";

const __dirname = import.meta.dirname;
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

interface ScreenDigestError extends Error {
  screenDigest?: string;
}

function spawnText(
  cmd: string,
  args: string[],
  opts: SpawnOptions = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout?.on("data", (d: Buffer | string) => (out += d.toString()));
    p.stderr?.on("data", (d: Buffer | string) => (err += d.toString()));
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

export async function runFlow(
  slug: string,
  fn: (ctx: MobileFlowCtx) => Promise<FlowResult | void>
): Promise<void> {
  const state = await setup({ runId: `${slug}-${defaultRunId()}` });
  console.log(`[runFlow] ${slug}`);
  console.log(`  run dir : ${path.relative(REPO_ROOT, state.runDir)}`);
  console.log(`  target  : ${state.platform} ${state.udid}`);

  let stepIdx = 0;
  const nextLabel = (hint?: string): string => {
    stepIdx += 1;
    const n = String(stepIdx).padStart(2, "0");
    return hint ? `${n}-${hint}` : `${n}-step`;
  };

  const notes: string[] = [];
  // The honest bound on "did this flow observe anything before it failed"
  // (#890). We can only know a chunk RAN, never which directive inside it was
  // reached, so a chunk's assertions count once `maestro test` exits 0 and the
  // chunk that threw contributes zero. That undercounts — a chunk failing on
  // its last of six assertions reports none of them — and undercounting is the
  // safe direction: it never inflates the evidence a failure claims to have.
  let assertionsRun = 0;
  // Commands staged by `ctx.restart()` / reuse-mode `ctx.configureGateway()`
  // rather than spawned: each `maestro test` costs ~9-15s of JVM start, and
  // every caller of those two immediately follows with a `ctx.run()` the launch
  // can ride along in. Nothing is dropped — a prefix still pending when the flow
  // ends, or when `ctx.device()` needs the relaunch to have happened, runs as
  // its own chunk under the label it would have had.
  let pendingPrefix = "";
  const pendingLabels: string[] = [];
  const run = async (
    yaml: string,
    hint?: string,
    options: MaestroRunOptions = {}
  ): Promise<void> => {
    const label = nextLabel(hint);
    console.log(`  run     : ${label}`);
    const chunk = prependPrefix(pendingPrefix, yaml);
    pendingPrefix = "";
    pendingLabels.length = 0;
    await runMaestroChunk(chunk, { state, label, ...options });
    assertionsRun += countMaestroAssertions(chunk);
  };
  const stagePrefix = (commands: string, label: string): void => {
    pendingPrefix += commands;
    pendingLabels.push(label);
    console.log(`  prefix  : ${label} folded into the next chunk`);
  };
  const flushPrefix = async () => {
    if (!pendingPrefix) return;
    await run(`appId: ${state.appId}\n---\n`, pendingLabels.join("-"));
  };
  // THE DEVICE ESCAPE (#890 follow-up). Maestro drives ONE app's UI and nothing
  // around it, which is why six W5 journeys were recorded as blocked on "tooling
  // the harness does not wrap": a biometric touch, a share intent from another
  // app, a pushed notification and a seeded photo library all originate OUTSIDE
  // the app under test and have no Maestro directive at all. Each of them is one
  // `adb` or `simctl` invocation, and the only thing missing was somewhere to
  // put it.
  //
  // TARGETED AT state.udid, never at "the device". A flow that shells out to a
  // bare `adb` hits whichever emulator answers first, which on a runner hosting
  // two is a coin flip and produces the worst kind of failure: intermittent, and
  // attributed to the app.
  //
  // ARGV, NOT A STRING — but read the next paragraph before trusting that.
  // Nothing here interpolates a flow's data through the HOST's shell, because
  // spawnText passes argv directly.
  //
  // `adb shell` IS STILL A SHELL, and this is the trap. adb joins its argv with
  // spaces and WITHOUT escaping (its own source carries the comment "We don't
  // escape here, just like ssh(1)"), then hands the result to `/system/bin/sh`
  // on the device. So for `adb shell …` the flow's data is parsed by the
  // DEVICE's shell even though the host never saw a shell: a payload containing
  // spaces splits into separate words, and one containing an apostrophe opens a
  // quote that is never closed. Use `shQuote` on every interpolated value in an
  // `adb shell` argv. Not needed for plain `adb` verbs (`emu`, `install`) or for
  // simctl, neither of which re-parses.
  const device = async (
    args: string[],
    { label }: { label?: string } = {}
  ): Promise<string> => {
    await flushPrefix();
    const hint = label ?? args[0] ?? "device";
    console.log(`  device  : ${hint}`);
    if (state.platform === "android")
      return spawnText("adb", ["-s", state.udid, ...args]);
    const verb = args[0];
    if (!verb) throw new Error("device() needs a simctl verb");
    return spawnText("xcrun", ["simctl", verb, state.udid, ...args.slice(1)]);
  };

  const ctx = {
    state,
    note(m: string) {
      notes.push(m);
      console.log(`  note    : ${m}`);
    },
    run,
    device,
    flush: flushPrefix,
  } as MobileFlowCtx;

  // Mint the one-time pairing ticket the phone will redeem.
  //
  // Two lanes, because the two rigs have different custody. `MAESTRO_GATEWAY_DATA_DIR`
  // drives `centraid-gateway pair`, the supported host-custody path: it derives the
  // daemon's loopback bearer from the data dir itself, which a bare `fetch` cannot
  // (the route answers `unauthorized` without it). Use this against a real
  // `centraid-gateway serve` — the only gateway that owns an iroh endpoint, and
  // therefore the only one whose ticket the phone can actually dial.
  // The HTTP lane stays for a tokenless embedded host that already grants host
  // custody to loopback.
  const mintPairingTicket = async (
    gatewayUrl: string,
    gatewayToken: string
  ): Promise<string> => {
    const dataDir = process.env.MAESTRO_GATEWAY_DATA_DIR;
    if (dataDir) {
      const cli = path.join(REPO_ROOT, "packages/server/dist/cli/cli.js");
      const port = new URL(gatewayUrl).port;
      // A daemon started with a pinned `CENTRAID_GATEWAY_TOKEN` rejects the
      // bearer the CLI would otherwise derive from `keys/endpoint-key.bin`, so
      // the pin has to travel with the subprocess.
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
      // The CLI prints node's SQLite ExperimentalWarning on stdout's sibling
      // stream, but its JSON is the last line either way.
      const line = out.trim().split("\n").at(-1);
      const parsed: unknown = JSON.parse(line ?? "{}");
      const ticket =
        parsed &&
        typeof parsed === "object" &&
        "ok" in parsed &&
        parsed.ok === true &&
        "ticket" in parsed &&
        typeof parsed.ticket === "string"
          ? parsed.ticket
          : null;
      if (!ticket) {
        const detail =
          parsed && typeof parsed === "object" && "error" in parsed
            ? String(parsed.error)
            : "no ticket";
        throw new Error(
          `centraid-gateway pair refused a mobile ticket (${detail})`
        );
      }
      return ticket;
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
    const ticketResult: unknown = await ticketResponse.json().catch(() => ({}));
    const minted =
      ticketResult &&
      typeof ticketResult === "object" &&
      "ok" in ticketResult &&
      ticketResult.ok === true &&
      "ticket" in ticketResult &&
      typeof ticketResult.ticket === "string"
        ? ticketResult.ticket
        : null;
    if (!ticketResponse.ok || !minted) {
      const detail =
        ticketResult &&
        typeof ticketResult === "object" &&
        "error" in ticketResult
          ? String(ticketResult.error)
          : String(ticketResponse.status);
      throw new Error(`gateway refused mobile pairing ticket (${detail})`);
    }
    return minted;
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

    // #603 removed the local/manual-URL bypass: every fresh client must redeem
    // a real one-time pairing ticket. #634 made the profile step conditional:
    // an owner who already has a name goes straight to Done, while one still
    // carrying the placeholder label is asked for a profile. The gateway URL
    // is used only by the host-side harness to mint that ticket; the phone
    // reaches the gateway through the ticket's iroh endpoint.
    //
    // SPLIT AT THE CAPABILITY (#905 P). Everything up to the ticket field is
    // ordinary onboarding: a cold launch and two taps, with nothing on screen
    // and nothing in the environment that is worth protecting. It used to ride
    // in the sensitive chunk anyway, which cost twice over — the ticket was
    // handed to steps that never use it, and the chunk that fails most often on
    // this lane was the one chunk that may not say what it saw. The failing
    // assertion below is the FIRST in the journey, long before redemption.
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

    // From here the capability is real: the ticket is in the environment and,
    // once typed, on the screen. Kept named `configure-gateway` so the
    // workflow's pre-upload scrub keeps matching it.
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

    // A second, non-sensitive Maestro chunk keeps the pairing capability out
    // of retained diagnostics while proving both legitimate identity paths.
    // Ownership (#726) killed the pre-named-invite mint: a ticket can no
    // longer carry a chosen label, so the FIRST pairing against a fresh
    // gateway always lands the placeholder owner "You" (not a set name) and
    // shows the form. A later flow that reuses the same nightly gateway
    // process finds that owner already renamed "Nightly" by the run below
    // and skips straight to Done — both are real product paths, so the
    // pattern above accepts either.
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

  /**
   * Ensure one deterministic scenario exists before pairing. Seeding on the
   * host first means the phone's initial replica clone contains the corpus;
   * flows never race a later refresh or depend on execution order. The GET
   * guard also lets all five Photos journeys share one gateway boot safely.
   */
  // Both delegate to lib/demo-corpus.mjs, which the LANE also calls before any
  // flow pairs (#905). Keeping the HTTP in one place is not tidiness here: the
  // lane seeder and these two have to agree on the row-count guard, or the
  // lane's corpus would be re-seeded per flow — or worse, disagree about
  // whether one is present.
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

  // Mirror desktop's ctx.restart(): kill the app process so AsyncStorage
  // flushes, then relaunch without clearing state. The 300ms delay before
  // stopApp gives RN's AsyncStorage time to enter its persistence pipeline
  // (analogous to the desktop harness's flushMs before SIGTERM).
  ctx.restart = async () => {
    console.log("  restart …");
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
    stagePrefix(restartCommands(), "restart");
  };

  let error: unknown;
  let result: FlowResult | void = undefined;
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

  // Owner must be the flow FILE the matrix names, not the flow id: a flow is
  // free to carry an id that does not match its filename, and an id-derived
  // path makes the evidence unmappable in the zero-grey report.
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
    result: result ?? undefined,
    metadata: { platform: state.platform, udid: state.udid, app: state.appId },
    debug:
      "Maestro keeps per-step screenshots and ai-report.html under `~/.maestro/tests/<timestamp>/`; the newest directory belongs to this run.",
    owner,
  });

  // The ledger is EVIDENCE, never a gate: a flow that did its job and then
  // could not be recorded still passed. Failing here would let a read-only
  // checkout or a full disk red a green nightly, so the failure is a warning
  // naming the path — the one fact needed to fix it (#890).
  const failure = pass
    ? null
    : classifyFailure({
        error,
        assertionsRun,
        stdout:
          error instanceof Error
            ? ((error as ScreenDigestError).screenDigest ?? "")
            : "",
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
      `  ledger  : could not append to ${ledgerPathFromEnv()} — ${ledgerError instanceof Error ? ledgerError.message : String(ledgerError)}`
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
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
