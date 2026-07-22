/*
 * Gateway identity constants for the version handshake (issue #289 / #504).
 *
 * Single source of truth — clients and the gateway import from here. Exact-
 * match-or-refuse in v0 (pre-release, no compat guarantees).
 */

/** The gateway software version. Mirrors the monorepo package version. */
export const GATEWAY_VERSION = '0.1.0';

/**
 * The vault schema epoch. Bump on ANY breaking change to the vault DDL or
 * the gateway HTTP/tunnel contract; clients refuse a gateway whose epoch
 * differs from their own.
 */
export const GATEWAY_SCHEMA_EPOCH = 2;
