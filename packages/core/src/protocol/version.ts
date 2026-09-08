/*
 * Three version numbers (#512). Handshake compares GATEWAY_PROTOCOL_VERSION,
 * never GATEWAY_VERSION (display/changelog only). Peer protocol is a fourth
 * number, independent — coupling would make every client bump an unlink (#726).
 */

export const GATEWAY_VERSION = "0.1.0";

export const GATEWAY_PROTOCOL_VERSION = 3;

/** Refuse peers outside the mutual window. v3 (#726) hard floor, no COMPAT shims. */
export const GATEWAY_MIN_PROTOCOL_VERSION = 3;

/*
 * v2 (#929): the peer plane carries replica subscriptions. Floor moves with the
 * number — a v1 gateway cannot serve or ingest a grant-keyed shape, and a
 * degraded snapshot fallback beside it is exactly the historical shape
 * docs/protocol.md § (b) forbids. Both ends are one maintainer's; the older one
 * sees the single update wall.
 */

export const PEER_PROTOCOL_VERSION = 2;

export const PEER_MIN_PROTOCOL_VERSION = 2;
