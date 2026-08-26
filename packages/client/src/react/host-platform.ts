/*
 * Which shell is hosting this React bundle (docs/platform-gating.md).
 *
 * `boot.tsx` is shared verbatim by the Electron renderer and the web PWA, and
 * first run diverges between them (#603): the desktop can start a fresh
 * gateway on this machine, the browser can only join one that already exists.
 * The decision has to be synchronous — it drives the FIRST paint, before any
 * bridge round trip — so this reads a marker the two hosts differ on rather
 * than awaiting `getHostCapabilities()`.
 *
 * The marker: the web host installs the Iroh browser transport
 * (`window.CentraidIroh`, `apps/web/src/main.ts`) before importing this
 * bundle. The Electron preload never does — desktop reaches its gateway over
 * loopback HTTP. Never branch security or auth on this; it is presentation
 * only.
 */

export function isWebHost(): boolean {
  return typeof window !== "undefined" && window.CentraidIroh !== undefined;
}

/**
 * This bundle's SEAT (docs/blueprint-seats.md S1) — where bytes live and
 * which way they flow, orthogonal to compact form factor. One bundle serves
 * both desktop (custodian: the gateway is a local child process, bytes are
 * effectively local) and web (viewer: a replica of meaning, bytes arrive
 * only on request), so the seat resolves from the same first-paint host
 * marker `isWebHost()` reads above — `window.CentraidIroh`, installed by
 * the web host and never by the Electron preload. Mobile's `origin` seat
 * lives in its own bundle, since that runtime never shares this module.
 *
 * Presentation only, same caveat as `isWebHost()` — never branch custody
 * logic, auth, or security on the result. The one exception this repo
 * makes is S5's Locker mount-time refusal (InlineAppRoute), which is a UI
 * decision (what to render), not a security boundary.
 */
export function seat(): "custodian" | "viewer" {
  return isWebHost() ? "viewer" : "custodian";
}
