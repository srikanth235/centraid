/*
 * TRAP 2 at the daemon seam (#726): a linked gateway must never be
 * able to become a paired owner device.
 *
 * The two lanes meet in exactly one file — `endpoint-host.ts` — and each of
 * these assertions fails if someone reuses the device decision, the device
 * headers, or the device resolution for a peer.
 */

import type http from "node:http";

import { describe, expect, it } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";
import {
  DEVICE_IDENTITY_HEADER,
  PEER_ENDPOINT_HEADER,
  PEER_PROOF_HEADER,
  TUNNEL_FORWARDED_HEADER,
} from "@centraid/tunnel";

import { EnrollmentStore } from "../serve/enrollment-store.js";
import { makeDaemonDevicePlane, DEVICE_HEADER } from "./endpoint-host.js";
import { daemonLayoutFor } from "./paths.js";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function makePlane() {
  const layout = daemonLayoutFor(tempDirSync("centraid-peer-host-"));
  const enrollments = EnrollmentStore.open(layout.gatewayDbFile);
  enrollments.enroll({
    endpointId: "ep-device",
    vaultIds: ["vlt_local"],
    label: "phone",
  });
  const plane = makeDaemonDevicePlane({
    layout,
    vaults: () => undefined,
    logger: silentLogger,
    loopbackEndpointId: "ep-host",
    relays: "disabled",
  });
  return { plane, enrollments };
}

const loopbackRequest = (headers: Record<string, string>) =>
  ({
    headers,
    socket: { remoteAddress: "127.0.0.1" },
  }) as unknown as http.IncomingMessage;

describe("peer lane separation", () => {
  it("does not answer the peer question with the device answer", () => {
    const { plane } = makePlane();
    // An ENROLLED DEVICE is admitted on the device lane and refused on the
    // peer lane: pairing is not linking.
    expect(plane.dataPlaneControl.authorize("ep-device").allowed).toBe(true);
    expect(plane.dataPlaneControl.authorizePeer?.("ep-device").allowed).toBe(
      false
    );
  });

  it("keeps the peer plane shut until there is a link or a live ceremony", () => {
    const { plane } = makePlane();
    expect(plane.dataPlaneControl.authorizePeer?.("ep-stranger").allowed).toBe(
      false
    );
    plane.peerPlane.links.tickets.mint("vlt_local", "k".repeat(43));
    expect(plane.dataPlaneControl.authorizePeer?.("ep-stranger").allowed).toBe(
      true
    );
  });

  it("stamps peer identity headers disjoint from the device ones", () => {
    const { plane } = makePlane();
    plane.peerPlane.links.tickets.mint("vlt_local", "k".repeat(43));
    const decision = plane.dataPlaneControl.authorizePeer?.("ep-scanner");
    const headers = decision?.headers ?? {};
    expect(headers[PEER_ENDPOINT_HEADER]).toBe("ep-scanner");
    expect(headers[PEER_PROOF_HEADER]).toBe(plane.peerPlane.proof);
    expect(headers[TUNNEL_FORWARDED_HEADER]).toBe("1");
    // And nothing a device route reads.
    expect(headers[DEVICE_HEADER]).toBeUndefined();
    const deviceHeaders =
      plane.dataPlaneControl.authorize("ep-device").headers ?? {};
    expect(deviceHeaders[PEER_ENDPOINT_HEADER]).toBeUndefined();
  });

  it("never claims a vault on the wire, even once a link exists", () => {
    // An endpoint identifies a machine, not a vault: a linked peer may hold
    // routes to several of the owner's vaults, so the forwarder must not pick
    // one via an endpoint-only lookup and stamp it as THE vault for this
    // caller. The route layer resolves the (endpoint, vault) pair itself, per
    // request — see `identify()` in `routes/peer-plane.ts`.
    const { plane } = makePlane();
    const ticket = plane.peerPlane.links.tickets.mint(
      "vlt_local",
      "k".repeat(43)
    );
    plane.peerPlane.links.redeem({
      ticketId: ticket.ticketId,
      secret: ticket.secret,
      peerVaultId: "vlt_peer",
      peerPublicKey: "a".repeat(43),
      route: {
        endpointId: "ep-linked",
        relayHints: [],
        assertedAt: Date.now(),
      },
      peerLabel: "Priya",
      localLabel: "Home",
    });
    const headers =
      plane.dataPlaneControl.authorizePeer?.("ep-linked").headers ?? {};
    expect(Object.keys(headers)).not.toContain("x-centraid-peer-vault");
  });

  /*
   * The last line of the trap: even if a peer-forwarded request reached a
   * device-tier route, it resolves to NO device — so it can never act for the
   * gateway's owner.
   */
  it("never resolves a device key for a peer-forwarded request", () => {
    const { plane } = makePlane();
    expect(plane.deviceAccess.deviceKeyFor(loopbackRequest({}))).toBe(
      "ep-host"
    );
    expect(
      plane.deviceAccess.deviceKeyFor(
        loopbackRequest({ [PEER_ENDPOINT_HEADER]: "ep-linked" })
      )
    ).toBeUndefined();
    expect(
      plane.deviceAccess.deviceKeyFor(
        loopbackRequest({
          [PEER_ENDPOINT_HEADER]: "ep-linked",
          [DEVICE_IDENTITY_HEADER]: "ep-device",
        })
      )
    ).toBeUndefined();
  });

  it("refuses host custody to anything the peer forwarder stamped", () => {
    const { plane } = makePlane();
    expect(
      plane.isHostCustody(loopbackRequest({ [TUNNEL_FORWARDED_HEADER]: "1" }))
    ).toBe(false);
  });
});
