/*
 * Cross-language ALPN + peer-prefix pin (issue #726 P3).
 *
 * The Rust relay is the PRODUCTION listener and the TypeScript endpoint is the
 * fallback; each declares the ALPN strings independently. Nothing used to hold
 * them together, and a drift does not fail a build, a typecheck, or a unit
 * test — it fails at ALPN negotiation, on a real network, as an unexplained
 * refusal to connect.
 *
 * There is no runtime bridge between the two languages here (the Rust side is
 * a separate cargo crate with no NAPI export for these constants), so this
 * test READS THE RUST SOURCE and pins the declarations against the TypeScript
 * values. Reading beats hand-copying: a hand-copied expectation drifts with
 * the same edit that breaks the wire.
 */

import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { GW_PAIR_ALPN } from "./gateway-endpoint.js";
import {
  PAIR_ALPN,
  PEER_LINK_ALPN,
  PEER_PLANE_PREFIX,
  TUNNEL_ALPN,
} from "./protocol.js";

const RUST_LIB = fileURLToPath(
  new URL("../data-plane/src/lib.rs", import.meta.url)
);

const RUST_RELAY = fileURLToPath(
  new URL("../data-plane/src/iroh_relay.rs", import.meta.url)
);

const RUST_PLANE = fileURLToPath(
  new URL("../data-plane/src/plane.rs", import.meta.url)
);

/** `pub const NAME: &[u8] = b"value";` → `value`. */
function rustByteConst(source: string, name: string): string | undefined {
  const match = new RegExp(
    `pub const ${name}: &\\[u8\\] = b"(?<value>[^"]*)";`,
    "u"
  ).exec(source);
  return match?.groups?.value;
}

/** `pub const NAME: &str = "value";` → `value`. */
function rustStrConst(source: string, name: string): string | undefined {
  const match = new RegExp(
    `pub const ${name}: &str = "(?<value>[^"]*)";`,
    "u"
  ).exec(source);
  return match?.groups?.value;
}

describe("rust ↔ typescript wire constants", () => {
  const lib = fs.readFileSync(RUST_LIB, "utf8");

  it("declares every ALPN identically in both languages", () => {
    expect(rustByteConst(lib, "TUNNEL_ALPN")).toBe(TUNNEL_ALPN);
    expect(rustByteConst(lib, "PAIR_ALPN")).toBe(PAIR_ALPN);
    expect(rustByteConst(lib, "GW_PAIR_ALPN")).toBe(GW_PAIR_ALPN);
    expect(rustByteConst(lib, "PEER_LINK_ALPN")).toBe(PEER_LINK_ALPN);
  });

  it("declares the peer plane prefix identically in both languages", () => {
    expect(rustStrConst(lib, "PEER_PLANE_PREFIX")).toBe(PEER_PLANE_PREFIX);
  });

  it("keeps the peer ALPN distinct from every device-lane ALPN", () => {
    const lanes = new Set([TUNNEL_ALPN, PAIR_ALPN, GW_PAIR_ALPN]);
    expect(lanes.has(PEER_LINK_ALPN)).toBe(false);
    expect(PEER_LINK_ALPN).toBe("centraid/gw-link/1");
  });

  it("keeps the Rust relay's peer confinement wired to the shared prefix", () => {
    // A guard that stopped reading PEER_PLANE_PREFIX would silently stop
    // being the same rule as the TypeScript one. The guard lives in plane.rs
    // (extracted from iroh_relay.rs for the file-size cap); the relay must
    // still be the call site.
    const plane = fs.readFileSync(RUST_PLANE, "utf8");
    expect(plane).toContain("fn peer_target_allowed(target: &str) -> bool");
    expect(plane).toContain("target.starts_with(PEER_PLANE_PREFIX)");
    const relay = fs.readFileSync(RUST_RELAY, "utf8");
    expect(relay).toContain("peer_target_allowed(&header.target)");
  });
});
