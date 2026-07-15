/*
 * Gateway identity for the version handshake (issue #289).
 *
 * A local gateway is in lockstep with the app that embeds it; a VPS daemon
 * serving several desktops is not. Clients read `GET /centraid/_gateway/info`
 * on connect and compare BOTH fields — v0 policy is exact-match or refuse
 * (pre-release, no compat guarantees), so the first skewed upgrade fails
 * loudly instead of producing undebuggable weirdness.
 */

/** The gateway software version. Mirrors the package version. */
export const GATEWAY_VERSION = '0.1.0';

/**
 * The vault schema epoch. Bump on ANY breaking change to the vault DDL or
 * the gateway HTTP/tunnel contract; clients refuse a gateway whose epoch
 * differs from their own.
 */
export const GATEWAY_SCHEMA_EPOCH = 2;
