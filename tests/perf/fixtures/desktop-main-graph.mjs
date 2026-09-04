/**
 * DESKTOP MAIN-PROCESS IMPORT-GRAPH PROBE (#883 C1).
 *
 * The desktop cold-start finding on the record (tests/journeys.json
 * desktop.json, 2026-07-31) is that 99% of the 4.5 s a vault owner waits is
 * MAIN-PROCESS boot before any window exists. Nothing in the continuous lanes
 * could see that: `tests/perf/desktop-cold.perf.test.ts` used to import
 * `apps/desktop/src/main/gateway-supervisor-core.ts`, a file with ZERO imports,
 * so it timed a single module parse and reported a "desktop cold" number that
 * could not move if the whole `@centraid/server` barrel doubled.
 *
 * This fixture times the part of main-process boot that is actually import
 * cost: `apps/desktop/dist/main/local-gateway.js` and the sibling main modules
 * (`detached-gateway`, `gateway-secrets`, `gateway-store`, `settings`,
 * `phone-link`) that the local-gateway path drags in. It runs in a FRESH child
 * process so the measurement is a genuine cold import, not a warm ESM cache.
 *
 * WHAT THE GRAPH NO LONGER CONTAINS (#883 C5). Through C1 this entry pulled
 * `embedded-gateway.js` → the whole `@centraid/server` barrel: 900 of the
 * 1,003 modules it reported. `embedded-gateway.js` is now a DYNAMIC import
 * inside `local-gateway.ts`'s `startEmbedded`, and the two modules that wanted
 * one small helper each from the barrel (`gateway-paths.ts`,
 * `detached-gateway.ts`) import `@centraid/server` SUBPATHS instead. A probe
 * that starts reporting ~1,000 modules again has had a barrel put back on the
 * critical path — that is the regression `MAX_MODULES` in the owning rig
 * exists to catch, not a host difference.
 *
 * Electron without Electron: the graph statically imports `electron`, which
 * cannot be resolved by plain node. A synchronous `module.registerHooks()`
 * resolve/load pair answers that one specifier with an inert stub — every
 * export the graph names, none of them called at module scope (verified: the
 * electron-importing modules in this graph only touch `app` inside function
 * bodies). Stubbing keeps the probe honest about what it does NOT measure:
 * the Electron runtime's own startup, V8 snapshot restore, and window creation
 * are Electron's cost and are owned by `apps/desktop/tests/e2e/launch-time.spec.ts`.
 *
 * Reports wall-clock import milliseconds and the module count the graph pulls
 * in, on one JSON line on stdout. The module count is the load-bearing half:
 * it is what a narrower entry point moves, and it is far less host-sensitive
 * than the duration.
 */
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const STUB_URL = "centraid-perf-stub:electron";

/**
 * Every named export the desktop main graph imports from `electron`, plus the
 * default. `app.getPath` is the only member reachable during a plain import
 * (module-scope constant initialisation), and returning a temp path keeps a
 * future top-level call from throwing instead of being measured.
 */
const ELECTRON_STUB_SOURCE = `
const noop = () => undefined;
const inert = new Proxy(function inert() {}, {
  get: (target, property) =>
    property === "then" ? undefined : inert,
  apply: () => inert,
  construct: () => inert,
});
export const app = {
  getPath: () => "/tmp/centraid-desktop-main-graph-probe",
  getName: () => "Centraid",
  getVersion: () => "0.0.0-probe",
  isPackaged: false,
  on: noop,
  once: noop,
  whenReady: () => new Promise(() => undefined),
  requestSingleInstanceLock: () => true,
  setLoginItemSettings: noop,
  getLoginItemSettings: () => ({ openAtLogin: false }),
};
export const BrowserWindow = inert;
export const Menu = inert;
export const Notification = inert;
export const Tray = inert;
export const dialog = inert;
export const ipcMain = inert;
export const nativeImage = inert;
export const powerMonitor = inert;
export const safeStorage = inert;
export const screen = inert;
export const session = inert;
export const shell = inert;
export default { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, powerMonitor, safeStorage, screen, session, shell };
`;

let modulesLoaded = 0;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "electron") return { url: STUB_URL, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    modulesLoaded += 1;
    if (url === STUB_URL) {
      return {
        format: "module",
        source: ELECTRON_STUB_SOURCE,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const entry = process.argv[2];
if (!entry) {
  throw new Error(
    "desktop main-graph fixture needs the built main module to import"
  );
}
const entryUrl = pathToFileURL(path.resolve(entry)).href;

const started = performance.now();
const loaded = await import(entryUrl);
const importMs = performance.now() - started;

if (typeof loaded !== "object" || loaded === null) {
  throw new Error(`${entry} did not evaluate to a module namespace`);
}
// Anti-vacuity: a graph this size cannot be one module, and a mis-pathed
// entry that resolved to an empty file would otherwise report a fast import.
const exportCount = Object.keys(loaded).length;

process.stdout.write(
  `${JSON.stringify({
    entry,
    importMs,
    modulesLoaded,
    exportCount,
    heapUsedBytes: process.memoryUsage().heapUsed,
  })}\n`
);
