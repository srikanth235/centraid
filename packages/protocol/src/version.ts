/*
 * Three version numbers for Centraid (issue #512).
 *
 * 1. GATEWAY_VERSION (product) — humans, changelog, installers. Never use for
 *    runtime control flow.
 * 2. Build numbers (mobile/stores) — derived from product semver by
 *    apps/mobile/src/version-core.cjs; not stored here.
 * 3. GATEWAY_PROTOCOL_VERSION — only number the handshake may compare.
 *
 * Surfaces may skip *shipping* a product version; monorepo stamps never diverge.
 */

/**
 * Product version string. Mirrors root monorepo package version.
 * Display / about / changelog only — **not** a connect gate.
 */
export const GATEWAY_VERSION = '0.1.0';

/**
 * Wire protocol version (CapVer-style integer).
 * Bump only when the gateway↔client wire contract changes in a way that
 * requires a coordinated floor. Feature flags live in capabilities (C1).
 */
export const GATEWAY_PROTOCOL_VERSION = 2;

/**
 * Oldest protocol this binary still speaks.
 * Gateway/clients refuse peers outside the mutual support window:
 *   peer.protocolVersion >= local.minSupported
 *   local.protocolVersion >= peer.minSupported
 */
export const GATEWAY_MIN_PROTOCOL_VERSION = 2;

/**
 * Vault / storage schema epoch. Keep equal to protocol until they diverge.
 * Prefer GATEWAY_PROTOCOL_VERSION for connect checks; still emit schemaEpoch
 * on the wire for older field readers.
 */
export const GATEWAY_SCHEMA_EPOCH = 2;
