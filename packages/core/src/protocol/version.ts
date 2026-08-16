/*
 * Three version numbers for Centraid (issue #512).
 *
 * 1. GATEWAY_VERSION (product) — humans, changelog, installers. Never use for
 *    runtime control flow.
 * 2. Build numbers (mobile/stores) — derived from product semver by
 *    apps/mobile/src/version-core.cjs; not stored here.
 * 3. GATEWAY_PROTOCOL_VERSION — the only number the handshake may compare.
 *
 * Surfaces may skip *shipping* a product version; monorepo stamps never diverge.
 */

/**
 * Product version string. Mirrors root monorepo package version.
 * Display / about / changelog only — **not** a connect gate.
 */
export const GATEWAY_VERSION = "0.1.0";

/**
 * Wire protocol version (CapVer-style integer).
 * Bump only when the gateway↔client wire contract changes in a way that
 * requires a coordinated floor. Feature flags live in capabilities (C1).
 */
export const GATEWAY_PROTOCOL_VERSION = 3;

/**
 * Oldest protocol this binary still speaks.
 * Gateway/clients refuse peers outside the mutual support window:
 *   peer.protocolVersion >= local.minSupported
 *   local.protocolVersion >= peer.minSupported
 *
 * v3 (#726 P0): ownership replaces roles — member/role wire fields became
 * owner fields, `canWrite` is gateway-supplied, and the `/share` plane is
 * gone. Hard floor, no COMPAT shims (pre-1.0 no-fallback policy).
 */
export const GATEWAY_MIN_PROTOCOL_VERSION = 3;

/*
 * Gateway↔GATEWAY protocol (issue #726 P3 decision 5).
 *
 * A fourth number, deliberately independent of the three above: two linked
 * gateways are two products on their owners' own upgrade schedules, and the
 * client-facing wire moves for reasons the peer plane does not share.
 * Coupling them would make every client-side bump an unlinking event.
 *
 * Exchanged at link dial. A mismatch is a REFUSED STATE — an update wall the
 * owner can act on — never a parse error and never a silent degrade.
 */
export const PEER_PROTOCOL_VERSION = 1;

/** Oldest peer protocol this binary still links with. Hard floor, no shims. */
export const PEER_MIN_PROTOCOL_VERSION = 1;
