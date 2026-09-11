import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import {
  FIRST_LAUNCH_TIMEOUT_MS,
  HOME_READY_MARKER,
  maestroChunkTimeoutMs,
} from "./harness-surface.ts";
import type { MobileRunState } from "./harness-surface.ts";
import { digestLines } from "./hierarchy-digest.ts";
import { spawnLive, spawnQuiet } from "./spawn.ts";

const execFileAsync = promisify(execFile);

interface ScreenDigestError extends Error {
  screenDigest?: string;
}

const HIERARCHY_TIMEOUT_MS = 20_000;
const HIERARCHY_MAX_BYTES = 16 * 1024 * 1024;

async function captureHierarchy(udid: string): Promise<string | undefined> {
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

/** Keep the tail bounded: a wedged app can fill logcat faster than anyone reads it. */
const LOGCAT_TAIL_LINES = 4000;
const LOGCAT_DIGEST_LINES = 40;

/**
 * What the app SAID while it was failing, reduced to the replica story.
 *
 * The screen digest answers "what was drawn"; nothing so far has answered "why
 * was it drawn that way". A library that renders its empty state on a vault
 * holding sixteen rows is either a clone that never arrived or a read that
 * cannot see it, and those two look identical from the hierarchy. The app's own
 * console reaches logcat under `ReactNativeJS` even in the release artifact, so
 * this is available without changing one line of the bundle — which matters,
 * because the apk cache key hashes the bundle and a JS-only diagnostic would
 * cost a sixteen-minute rebuild to ask a question.
 *
 * Matched loosely on purpose. A regex tuned to today's phrasing goes quiet the
 * first time a message is reworded, and a quiet diagnostic is worse than none.
 */
const REPLICA_LOG_PATTERN =
  /replica|bootstrap|scope|vault|pull|sync|cursor|clone|undefined is not|Error|Exception/iu;

/**
 * The driver's own chatter, which defeated the filter above.
 *
 * Maestro walks the accessibility tree continuously and logs a line per skipped
 * node. Each carries `packageName: dev.centraid.mobile` and `error: null`, so
 * every one of them satisfies BOTH filters below — and at forty lines of tail
 * they push out everything the app said. Run 33489359040's notes-library digest
 * was one hundred percent this, which is why it named no cause.
 */
const DRIVER_NOISE_PATTERN = /\bMaestro\s*:/u;

async function printReplicaDigest(udid: string): Promise<void> {
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
    // One failing request repeats until the retry ladder gives up, and forty
    // copies of it push out the one line that says WHY (#905). Keyed on the
    // message with the pid/timestamp prefix dropped, so repeats collapse and
    // every distinct thing the app said survives the tail.
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
    // Same contract as the screen digest: never outlive the failure it explains.
  }
}

/**
 * Print the handles the failing screen is carrying.
 *
 * Read from the DEVICE, not from `--debug-output`: Maestro writes no hierarchy
 * there under `--flatten-debug-output` — run 33465058064 reported the directory
 * holding only `commands-(<chunk>.yaml).json`, `maestro.log` and a screenshot.
 * Maestro has exited by the time this runs but the app is still foregrounded on
 * the failing screen, so a live capture is both available and more truthful
 * than a file: it is the screen the assertion actually missed on.
 *
 * Swallows everything. This runs while an error is already in flight, and a
 * diagnostic that throws would replace the real failure with its own.
 */
async function printScreenDigest(
  udid: string,
  debugDir: string
): Promise<string[]> {
  try {
    const lines = digestLines(await captureHierarchy(udid));
    if (lines.length > 0) {
      console.error("  the screen carried:");
      for (const line of lines) console.error(`    ${line}`);
      return lines;
    }
    // A SILENT NO-OP IS A FAILURE. If the capture came back empty the reason is
    // the next thing anyone needs, so say what the run dir does hold rather
    // than printing nothing and looking like a screen with no handles.
    const names = await fs
      .readdir(debugDir, { recursive: true })
      .catch(() => []);
    console.error(
      `  no hierarchy from the device; ${path.basename(debugDir)} holds: ${
        names.slice(0, 20).join(", ") || "nothing"
      }`
    );
  } catch {
    // Never let the diagnostic outlive the failure it was meant to explain.
  }
  return [];
}

export async function runMaestroChunk(
  yaml: string,
  {
    state,
    label,
    maestroEnv = {},
    sensitive = false,
  }: {
    state: MobileRunState;
    label: string;
    maestroEnv?: Record<string, string>;
    sensitive?: boolean;
  }
): Promise<void> {
  const flowFile = path.join(state.flowsDir, `${label}.yaml`);
  const debugDir = path.join(state.runDir, "maestro-debug", label);
  await fs.writeFile(flowFile, yaml);
  // `--debug-output` redirects Maestro's own per-step screenshots and view
  // hierarchies into the run dir. Without it they land in `~/.maestro/tests/`,
  // which the nightly workflow does not upload — so a CI failure arrived with
  // literally no picture of the screen. A flow that fails *before* its first
  // `takeScreenshot` (the 2026-07-20 home-loads failure did) then leaves
  // nothing to diagnose at all. Keep this pointed inside `state.runDir`, which
  // is already an uploaded artifact path.
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
        // The chunk's own capabilities, so a failure can print its step lines
        // with every one of them replaced by exact match. `spawnLive` ignores
        // this; only the sensitive path reads it.
        secrets: Object.values(maestroEnv),
        timeoutMs: maestroChunkTimeoutMs(),
      }
    );
  } catch (error) {
    // THE SCREEN, on the failure path only. `Element not found` names the
    // selector that missed and nothing about what was there instead, which is
    // the difference between "Home rendered the other branch" and "the tile is
    // broken" — see hierarchy-digest.mjs. Printed rather than left in the
    // artifact because the artifact is not evidence to a reader who cannot
    // download it.
    //
    // NEVER for a sensitive chunk: its hierarchy is discarded below precisely
    // because it may hold a live enrollment capability, and reading it here to
    // print a digest would defeat the control. The `configure-gateway` guard
    // repeats the workflow's own pre-upload scrub as belt-and-braces, so a
    // chunk that pairs stays silent even if it is ever run non-sensitive.
    if (!sensitive && !label.includes("configure-gateway")) {
      const screen = await printScreenDigest(state.udid, debugDir);
      await printReplicaDigest(state.udid);
      // CARRIED ON THE ERROR, because the digest is the only witness to a
      // screen the assertion never reached — a system window over the app
      // looks, from the exit text alone, exactly like a first-assertion
      // regression (#905). `classifyFailure` reads it as `stdout`; a sensitive
      // chunk has no digest to carry, which is the control above, not a gap.
      if (error instanceof Error)
        (error as ScreenDigestError).screenDigest = screen.join("\n");
    }
    throw error;
  } finally {
    // A pairing ticket is a live enrollment capability. Sensitive flows use a
    // MAESTRO_* variable so the retained YAML contains only a placeholder, run
    // without console output, and discard Maestro's hierarchy/screenshots even
    // on failure. The workflow repeats this cleanup before artifact upload as a
    // defense against abrupt harness termination.
    if (sensitive) await fs.rm(debugDir, { force: true, recursive: true });
  }
}

/**
 * The commands a reuse-mode `configureGateway` contributes: a state-preserving
 * launch and a wait for Home. Body lines only — the chunk they are folded into
 * already carries the `appId:` header.
 *
 * @returns {string} YAML command lines.
 */
export function reusePairedCommands() {
  return `- launchApp:
    clearState: false
- extendedWaitUntil:
    visible: "${HOME_READY_MARKER}"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
`;
}

/**
 * The commands `ctx.restart()` contributes: an OS process boundary that clears
 * nothing, so only the vault's own bytes cross it.
 *
 * @returns {string} YAML command lines.
 */
export function restartCommands() {
  return `- stopApp
- launchApp:
    clearState: false
`;
}

/**
 * Fold staged command lines into a chunk, immediately after its `---` document
 * separator and before the chunk's own first command.
 *
 * @param {string} prefix Command lines to insert; empty leaves the chunk alone.
 * @param {string} yaml A chunk, which always opens `appId: …` then `---`.
 * @returns {string} The combined chunk.
 */
export function prependPrefix(prefix: string, yaml: string): string {
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

/**
 * Run a mobile agent-e2e flow end-to-end: discover sim → setup run dir →
 * exec → verdict.
 *
 * Usage in flows/<slug>.mjs:
 *
 *   import { runFlow } from '../lib/harness.ts';
 *   await runFlow('home-loads', async (ctx) => {
 *     await ctx.run(`
 *       appId: dev.centraid.mobile
 *       ---
 *       - launchApp: { clearState: true }
 *       - extendedWaitUntil: { visible: { text: "Connect your gateway." }, timeout: 30000 }
 *       - takeScreenshot: 01-ticket-onboarding
 *     `);
 *     ctx.note('ticket-only onboarding rendered after clearState');
 *     return { pass: true, notes: 'one-line verdict summary' };
 *   });
 *
 * ctx surface:
 *   ctx.state               read-only snapshot of {runId, runDir, udid, appId, ...}
 *   ctx.run(yaml, label?, options?) execute a YAML chunk; screenshots land under runs/.../screenshots/
 *   ctx.restart()           stopApp + launchApp without clearing state, staged onto the next chunk
 *   ctx.flush()             run any staged prefix now, so it lands outside a timed ctx.run()
 *   ctx.configureGateway()  pair from a clean state, or reuse the paired nightly profile when requested
 *   ctx.ensureDemo(appId)   seed a scenario before the initial replica clone, if absent
 *   ctx.purgeDemo(appId)    remove a scenario before an empty-vault journey
 *   ctx.note(msg)           record an observation; surfaces in verdict.md
 *   ctx.device(argv, opts?) one `adb -s <udid> …` / `xcrun simctl … <udid> …`
 *                           against THIS target — the escape for acts that
 *                           originate outside the app (a biometric touch, a
 *                           share intent, a pushed notification, a seeded
 *                           library). argv array only, never a shell string.
 *
 * Failure model: throw OR return { pass: false, ... }. Either writes a FAIL
 * verdict, leaves the run dir in place, and exits non-zero.
 *
 * runDir layout:
 *   runs/<slug-runId>/
 *     state.json
 *     flows/<NN-label>.yaml     ← every ctx.run() chunk, in order
 *     screenshots/<name>.png    ← whatever `takeScreenshot:` produced
 *     verdict.md                ← PASS/FAIL + notes (written last)
 */
