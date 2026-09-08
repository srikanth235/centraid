/*
 * Three version numbers (#512). Handshake compares GATEWAY_PROTOCOL_VERSION,
 * never GATEWAY_VERSION (display/changelog only). Peer protocol is a fourth
 * number, independent — coupling would make every client bump an unlink (#726).
 */

export const GATEWAY_VERSION = "0.1.0";

export const GATEWAY_PROTOCOL_VERSION = 4;

/**
 * Refuse peers outside the mutual window. Hard floor, no COMPAT shims.
 *
 * v4 (#996 wave 3): `multiVaultReplica` and `crossVaultPlacements` LEAVE
 * `GatewayCapabilities` in the same bump that deletes the mount plane they
 * described. A capability map is a required-key structural contract, so
 * dropping two required keys is a wire change either end would otherwise read
 * as malformed — and the honest answer to a peer on the other side of it is
 * the update wall, not a shim that pretends a deleted mechanism is present.
 */
export const GATEWAY_MIN_PROTOCOL_VERSION = 4;

/*
 * v2 (#929): the peer plane carries replica subscriptions. Floor moves with the
 * number — a v1 gateway cannot serve or ingest a grant-keyed shape, and a
 * degraded snapshot fallback beside it is exactly the historical shape
 * docs/protocol.md § (b) forbids. Both ends are one maintainer's; the older one
 * sees the single update wall.
 */

export const PEER_PROTOCOL_VERSION = 2;

export const PEER_MIN_PROTOCOL_VERSION = 2;
