/*
 * Peer handshake (issue #726 P3 decision 5). The contract under test is that
 * NOTHING a far gateway sends produces an exception: every input — absent,
 * malformed, hostile, or merely old — leaves as a named state.
 */

import { describe, expect, it } from "vitest";

import {
  judgePeerHandshake,
  peerHello,
  peerProtocolsCompatible,
} from "./peer.js";
import { PEER_MIN_PROTOCOL_VERSION, PEER_PROTOCOL_VERSION } from "./version.js";

describe("peer protocol constants", () => {
  it("keeps the link plane's number independent of the client wire", () => {
    expect(PEER_PROTOCOL_VERSION).toBeGreaterThan(0);
    expect(PEER_MIN_PROTOCOL_VERSION).toBeLessThanOrEqual(
      PEER_PROTOCOL_VERSION
    );
    expect(peerHello()).toStrictEqual({
      peerProtocolVersion: PEER_PROTOCOL_VERSION,
      minPeerProtocol: PEER_MIN_PROTOCOL_VERSION,
    });
  });
});

describe(judgePeerHandshake, () => {
  it("accepts a peer inside the mutual window", () => {
    expect(judgePeerHandshake(peerHello())).toStrictEqual({
      state: "ok",
      hello: peerHello(),
    });
  });

  /*
   * The "peer is too old" arm is unreachable while the floor is 1 — there is
   * no valid protocol number below it, so such a hello is malformed, not old.
   * This asserts that reading, so raising the floor later makes the arm live
   * without changing the shape of the answer.
   */
  it("treats a hello below the lowest valid number as malformed", () => {
    expect(PEER_MIN_PROTOCOL_VERSION).toBe(1);
    expect(judgePeerHandshake({ peerProtocolVersion: 0 }).state).toBe(
      "bad_request"
    );
  });

  it("refuses a peer whose floor this gateway is below, as an update wall", () => {
    const verdict = judgePeerHandshake({
      peerProtocolVersion: PEER_PROTOCOL_VERSION + 5,
      minPeerProtocol: PEER_PROTOCOL_VERSION + 5,
    });
    expect(verdict.state).toBe("protocol_refused");
    if (verdict.state !== "protocol_refused") return;
    expect(verdict.localProtocolVersion).toBe(PEER_PROTOCOL_VERSION);
    expect(verdict.localMinProtocol).toBe(PEER_MIN_PROTOCOL_VERSION);
    expect(verdict.detail).toMatch(/update/u);
  });

  it("treats a peer that names no floor as speaking only its own version", () => {
    const verdict = judgePeerHandshake({
      peerProtocolVersion: PEER_PROTOCOL_VERSION,
    });
    expect(verdict).toStrictEqual({
      state: "ok",
      hello: {
        peerProtocolVersion: PEER_PROTOCOL_VERSION,
        minPeerProtocol: PEER_PROTOCOL_VERSION,
      },
    });
  });

  it.each([
    undefined,
    null,
    42,
    "1",
    {},
    { peerProtocolVersion: "1" },
    { peerProtocolVersion: 0 },
    { peerProtocolVersion: -1 },
    { peerProtocolVersion: 1.5 },
    { peerProtocolVersion: Number.NaN },
    { peerProtocolVersion: 1, minPeerProtocol: 9 },
  ])("maps %o to a state rather than an exception", (raw) => {
    const verdict = judgePeerHandshake(raw);
    expect(verdict.state).toBe("bad_request");
  });
});

describe(peerProtocolsCompatible, () => {
  it("is mutual, not one-sided", () => {
    expect(
      peerProtocolsCompatible({
        peerProtocolVersion: PEER_PROTOCOL_VERSION,
        minPeerProtocol: PEER_MIN_PROTOCOL_VERSION,
      })
    ).toBe(true);
    expect(
      peerProtocolsCompatible({
        peerProtocolVersion: PEER_PROTOCOL_VERSION + 1,
        minPeerProtocol: PEER_PROTOCOL_VERSION + 1,
      })
    ).toBe(false);
  });
});
