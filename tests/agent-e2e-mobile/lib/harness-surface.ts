// Mobile agent-e2e harness surface: ids, markers, YAML snippets, and the
// ctx/state types flows import.
import { DEV_LAUNCHER_LINK } from "./metro.ts";

export interface MobileRunState {
  runId: string;
  runDir: string;
  screenshotsDir: string;
  flowsDir: string;
  udid: string;
  platform: string;
  appId: string;
  buildType: string;
}

export interface MaestroRunOptions {
  maestroEnv?: Record<string, string>;
  sensitive?: boolean;
}

export interface MobileFlowCtx {
  state: MobileRunState;
  note: (message: string) => void;
  run: (
    yaml: string,
    hint?: string,
    options?: MaestroRunOptions
  ) => Promise<void>;
  device: (args: string[], opts?: { label?: string }) => Promise<string>;
  flush: () => Promise<void>;
  configureGateway: (
    gatewayUrl?: string,
    gatewayToken?: string
  ) => Promise<void>;
  ensureDemo: (
    appId: string,
    gatewayUrl?: string,
    gatewayToken?: string
  ) => Promise<void>;
  purgeDemo: (
    appId: string,
    gatewayUrl?: string,
    gatewayToken?: string
  ) => Promise<void>;
  restart: () => Promise<void>;
}

// iOS bundle id, and the Android *release* applicationId. Android *debug*
// builds append `.debug` (applicationIdSuffix in android/app/build.gradle, kept
// so a debug build and a Play-release build can coexist on one device —
// J1/#501). `setup()` resolves the id per platform AND per build type and
// threads it through `state.appId`; flows must launch the package that is
// installed, not this base id, so they read `ctx.state.appId` rather than
// importing APP_ID.
export const APP_ID = "dev.centraid.mobile";

/**
 * Which artifact this run drives (#890 W1). `release` is what every scheduled
 * lane sets — CI tests the build a member installs, with the Hermes bundle
 * embedded, no Metro and no dev launcher. `dev` is the LOCAL exploratory rig:
 * `expo start --dev-client` plus a debug build, which is the loop the Maestro
 * MCP session uses and the only place the dev-harness machinery below belongs.
 *
 * Default `dev` rather than `release` on purpose. A local operator with a dev
 * build and Metro running is the unconfigured case, and defaulting the other way
 * would make their first run fail on a missing package with a confusing message.
 * Every CI lane sets it explicitly, and validate-nightly-wiring.mjs refuses a
 * lane that starts Metro, so the default cannot leak back into CI unnoticed.
 */
export const BUILD_TYPE =
  process.env.CENTRAID_MOBILE_BUILD === "release" ? "release" : "dev";
export const IS_RELEASE_BUILD = BUILD_TYPE === "release";

// A release Android build has NO applicationIdSuffix, so it installs under the
// base id; a debug build installs as `dev.centraid.mobile.debug`. iOS carries
// one bundle id for both configurations. Getting this wrong does not fail
// loudly at install — it fails several minutes later inside Maestro, on a
// launch of a package that is not there (#535).
export const appIdForPlatform = (platform: string): string =>
  platform === "android" && !IS_RELEASE_BUILD ? `${APP_ID}.debug` : APP_ID;

/**
 * Budget for the first `assertVisible` after a `clearState: true` launch.
 *
 * `clearState` wipes the dev build's cached JS bundle, so that first launch has
 * to refetch it from Metro. With a warm Metro transform cache that costs a few
 * seconds; with a cold one it is the dominant cost of the whole flow. Measured
 * on this repo: home-loads takes ~19s end-to-end against a warm Metro and ~43s
 * against a cold one on an M-series Mac. The nightly macOS runner is slower
 * still, which is exactly how the old 30s budget failed — CI's launch completed
 * at 13:05:24 and the assertion gave up at 13:05:55, 30s later, on copy that was
 * correct and did eventually render.
 *
 * `setup()` prewarms the bundle so this budget covers app start plus render
 * rather than a cold Metro build, but keep it generous: it is a bundle-fetch
 * wait, not a product-latency assertion, and nothing is proven by making it tight.
 *
 * #892 P0 — ON A RELEASE ARTIFACT THERE IS NO BUNDLE FETCH. Every sentence above
 * prices a dev client refetching its JS from Metro after `clearState`; a release
 * build carries its own Hermes bundle, so a cleared launch is a process start and
 * a first render and nothing else. Keeping the dev number on that path was not
 * merely generous, it was load-bearing in the wrong direction: `extendedWaitUntil`
 * spends its whole ceiling before failing, so each doomed wait burned two minutes
 * of a twelve-minute gate. 45s is still ~4x a healthy cold release launch on the
 * emulator's software GPU, and it is a ceiling, not a target — a passing flow
 * never reaches it.
 */
export const FIRST_LAUNCH_TIMEOUT_MS = IS_RELEASE_BUILD ? 45_000 : 120_000;

/**
 * Quote one value for the DEVICE's shell, for use inside an `adb shell` argv.
 *
 * `adb shell` joins its arguments with spaces and passes the result to
 * `/system/bin/sh` unescaped, so an interpolated payload is re-parsed there:
 * spaces split it into words and an apostrophe opens an unterminated quote.
 * Single quotes are the only fully literal form in `sh`, and the `'\\''` dance is
 * how a single quote is embedded in a single-quoted string — close, escape one
 * quote, reopen.
 *
 * @param {string} value Raw value to embed.
 * @returns {string} The value as one shell-safe word.
 */
export function shQuote(value: string): string {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}
// The Home band's accessibility label (apps/mobile/src/screens/home/
// HomeBand.tsx). The previous marker, "Home ready", was HomeStatusLine's
// settled-state label until #789 replaced that component's copy with the
// dynamic origin-health sentence — leaving every pairing flow waiting on a
// string the app no longer renders (#839). This label is Home-only and
// stable, but it is a render signal, not a settled signal: it appears when
// the band mounts, which may precede tile settlement.
export const HOME_READY_MARKER = "All apps and places";
// THE LAUNCHER — what "Home is ready" was always meant to mean (#905).
//
// The marker above renders in BOTH of Home's branches: the launcher grid and
// the `DayOne` empty-vault fallback (apps/mobile/src/screens/Home.tsx picks
// between them on `springboardState`). So it proves the band mounted and says
// nothing about whether the vault's contents arrived — and a flow that waits
// only for it walks into DayOne and then fails on its own selector. "could not
// tap Open Notes" is what the log said; "the initial replica clone had not
// landed yet" is what had happened.
//
// `home-grid` is published by `LauncherGrid` alone (kit/test-ids.ts
// `TEST_IDS.home.grid`), so it is the first thing on screen that tells the two
// branches apart. It is deliberately a HANDLE: every string on this screen is
// copy that moves, and the branch is the contract.
//
// Waiting on it is also the repair, not merely the diagnosis. Home's tile reads
// are LIVE — `useReplicaQuery` re-reads when a scope syncs — so a clone landing
// a beat after the band flips the screen by itself. Nothing polls; this wait is
// only what gives that beat somewhere to happen.
export const HOME_LAUNCHER_HANDLE = "home-grid";
// Budgeted like the pairing handshake rather than like a render: the initial
// clone crosses iroh, and on a cold emulator that is the slow part.
export const LAUNCHER_ARRIVAL_TIMEOUT_MS = 60_000;
/**
 * Wait for the launcher, for a flow whose next act is opening an app from Home.
 * A flow that deliberately faces an empty vault (a purge, a cleared client)
 * must NOT use this — DayOne is the correct screen there.
 */
export const AWAIT_LAUNCHER = `- extendedWaitUntil:
    visible:
      id: "${HOME_LAUNCHER_HANDLE}"
    timeout: ${LAUNCHER_ARRIVAL_TIMEOUT_MS}
`;
// iOS Simulator's `openLink` (simctl openurl) raises a system
// `Open in "Centraid"?` confirmation for custom-scheme links a moment AFTER the
// openLink directive returns; Android fires the VIEW intent directly. That half
// applies to EVERY build type and is why this constant survives #890 W1: a
// `centraid://` deep link is a product path, not dev-harness machinery.
//
// The second tap is the vestige. On a dev build, because CI reinstalled it every
// run, expo-dev-client showed its one-time "This is the developer menu"
// explainer sheet over whatever the app rendered — both screenshots in the 05:42
// home-loads run show "Connect your gateway." fully painted BEHIND that sheet.
// A release artifact has no developer menu, so on that path the tap matches
// nothing; it is kept rather than gated because `optional: true` already makes a
// non-match a no-op, and one constant that is correct on both build types beats
// two that can drift apart.
//
// `optional: true` absorbs the no-dialog cases (Android, an already-open
// session, or a release build); `^…$` anchors each tap so it cannot land on the
// dialog's own title text, which also contains "Open", or on prose that
// contains "Continue".
export const CONFIRM_SYSTEM_OPEN = `# iOS system confirmation for a custom-scheme openLink, then the dev-client
# first-run explainer — see CONFIRM_SYSTEM_OPEN.
- tapOn:
    text: "^Open$"
    optional: true
- tapOn:
    text: "^Continue$"
    optional: true
`;
// An individual chunk owns one coherent user interaction. Fresh pairing is the
// slowest legitimate chunk (~4 minutes on the reviewed CI runner); 12 minutes
// leaves ample network/render headroom while still terminating a wedged
// accessibility driver before the workflow's outer timeout destroys evidence.
const MAESTRO_CHUNK_TIMEOUT_MS = 12 * 60_000;

// #892 P0 — but 12 minutes is ALSO the whole pr-gate suite budget, so a single
// wedged chunk could spend it and leave the suite's own comparison to report an
// overrun it could no longer prevent. `lib/run-suite.mjs` publishes the suite's
// absolute deadline here; a chunk gets whichever is smaller. A lane with no
// deadline (a local `node flows/<flow>.ts`, the nightly's un-budgeted members)
// keeps the flat ceiling, so this only ever tightens.
//
// The floor exists because a clamp that reaches zero would kill Maestro before
// it connected and report a driver fault where the truth is "the budget was
// already gone" — the suite runner refuses to start a member in that state, and
// this is the same refusal expressed as a timeout.
const MAESTRO_CHUNK_FLOOR_MS = 15_000;

/**
 * The process timeout for one Maestro chunk: the flat ceiling, clamped to the
 * suite deadline when a suite runner published one.
 *
 * @param {number} [now] injectable clock for the unit suite
 * @returns {number} milliseconds
 */
export function maestroChunkTimeoutMs(now = Date.now()): number {
  const deadline = Number(process.env.CENTRAID_MOBILE_DEADLINE_MS);
  if (!Number.isFinite(deadline) || deadline <= 0) {
    return MAESTRO_CHUNK_TIMEOUT_MS;
  }
  const remaining = deadline - now;
  if (remaining >= MAESTRO_CHUNK_TIMEOUT_MS) return MAESTRO_CHUNK_TIMEOUT_MS;
  return Math.max(MAESTRO_CHUNK_FLOOR_MS, remaining);
}

// #890 W1 — the dev-launcher handoff, and the clearest example of what "the
// device under test is not the product" meant. On a DEV build,
// `launchApp: { clearState: true }` wipes expo-dev-client's stored "last opened"
// URL along with app state, so the plain relaunch sits on the launcher's empty
// server picker forever; every cleared-state launch therefore had to hand the
// launcher the Metro bundle URL explicitly, and then tap away the iOS
// `Open in "Centraid"?` confirmation and the one-time developer-menu explainer
// sheet. A RELEASE artifact has no launcher, no custom-scheme round trip and no
// developer menu — it just starts — so on that path this is the empty string
// and the flow observes what the member observes.
//
// Every flow that clears state itself must interpolate THIS rather than
// open-coding the openLink, or it will hang on the picker in dev and tap at
// nothing in release.
export const DEV_LAUNCHER_HANDOFF = IS_RELEASE_BUILD
  ? ""
  : `# clearState wiped the dev client's stored "last opened" URL, so the plain
# launch lands on the launcher's empty server picker. Hand it the bundle URL
# explicitly (DEV_LAUNCHER_LINK in lib/metro.mjs has the full story).
- openLink: "${DEV_LAUNCHER_LINK}"
${CONFIRM_SYSTEM_OPEN}`;
