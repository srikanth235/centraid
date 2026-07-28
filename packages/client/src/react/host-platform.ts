/*
 * Which shell is hosting this React bundle (docs/platform-gating.md).
 *
 * `boot.tsx` is shared verbatim by the Electron renderer and the web PWA, and
 * first run diverges between them (issue #603): the desktop can start a fresh
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
