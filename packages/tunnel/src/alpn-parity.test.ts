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

function rustByteConst(source: string, name: string): string | undefined {
  const match = new RegExp(
    `pub const ${name}: &\\[u8\\] = b"(?<value>[^"]*)";`,
    "u"
  ).exec(source);
  return match?.groups?.value;
}

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
    const relay = fs.readFileSync(RUST_RELAY, "utf8");
    expect(relay).toContain("fn peer_target_allowed(target: &str) -> bool");
    expect(relay).toContain("target.starts_with(PEER_PLANE_PREFIX)");
    expect(relay).toContain("peer_target_allowed(&header.target)");
  });
});
