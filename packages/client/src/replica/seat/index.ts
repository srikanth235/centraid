/* oxlint-disable oxc/no-barrel-file -- (#996) the seat store's public surface, one subpath (`@centraid/client/replica/seat`), the same boundary `replica/index.ts` has; governance: allow-no-unjustified-suppressions stable package API boundary */
// THE SEAT STORE (#996, wave 2).
//
// A seat holds `vault.db` whole. Everything here serves that one sentence:
// get the file, keep it in step with the log, and say how far behind it is.
//
// Host-specific entry points are deliberately NOT re-exported: `node-*` pulls
// `node:sqlite` and `node:fs` in, and the browser bundle must not see either.
// Import those by path from the host that has them.
export * from "./applier.js";
export * from "./blob-presence.js";
export * from "./bootstrap.js";
export * from "./byte-policy.js";
export * from "./carry-over.js";
export * from "./driver.js";
export * from "./http-snapshot-transport.js";
export * from "./seat-bootstrap-no-room-error.js";
export * from "./flag.js";
export * from "./seat-drift-error.js";
export * from "./seat-rebootstrap-required-error.js";
export * from "./seat-worker-client.js";
export * from "./watermark.js";
export * from "./web-seat.js";
export * from "./seat-snapshot-moved-error.js";
export * from "./seat-worker-not-open-error.js";
export * from "./outbox.js";
export * from "./read-overlay.js";
export * from "./seat-intent-store.js";
export * from "./state.js";
export * from "./storage-probe.js";
export * from "./worker-core.js";
export * from "./worker-protocol.js";
