/*
 * THE FORWARDER'S STAMP (#1015, ruling R-NY-18).
 *
 * LOOPBACK IS NOT AN IDENTITY (#568), and the desktop forwarder used to leave
 * the gateway with nothing else: it deleted every client identity header and
 * marked the hop forwarded. The gateway's embedded lane then fell back to the
 * HOST's own enrolment, so a paired phone reached every vault door — the
 * Locker key door included — as the owner of the box. Revoking that phone
 * changed nothing, because nothing had ever named it.
 *
 * WHAT THE STAMP IS. The forwarder names the EndpointId the QUIC handshake
 * authenticated, and carries an HMAC over that name under a key derived from
 * the LOOPBACK BEARER the gateway issued. Two properties follow, and they are
 * the whole design:
 *
 *   - a phone cannot mint one. The forwarder overwrites `authorization` on
 *     every hop, so the bearer never crosses the tunnel; a phone that guessed
 *     at the header gets its guess deleted before the request leaves.
 *   - anything that CAN mint one already holds the bearer, and a loopback
 *     caller holding the bearer can reach the gateway as the host directly —
 *     strictly more authority than naming a phone. The stamp therefore adds
 *     no reach to any caller; it only takes reach away from the phone lane.
 *
 * The proof is bound to the EndpointId it names, so a stamp minted for one
 * device is not a stamp for another. It is deliberately NOT bound to the
 * request: the hop is a process-to-process loopback write, and anything able
 * to read those bytes is already reading the bearer on the same line.
 *
 * The bearer is used only as HMAC key material, domain-separated by a label,
 * so the stamp never carries a substring of the bearer itself.
 */

import crypto from "node:crypto";

import {
  DEVICE_IDENTITY_HEADER,
  DEVICE_PROOF_HEADER,
  PEER_ENDPOINT_HEADER,
  TUNNEL_FORWARDED_HEADER,
} from "./protocol.js";

/**
 * The desktop's own vouch plane on the embedded gateway (R-NY-18).
 *
 * Host custody only. The QR gesture pairs a phone at the transport; this is
 * where that gesture becomes an enrolment the vault doors can resolve, and
 * where revoking the phone becomes a tombstone they refuse.
 */
export const PHONE_LINK_PATH = "/centraid/_gateway/phone-link";

const PROOF_LABEL = "centraid-tunnel-forward-identity-v1";

function forwardKey(hostBearer: string): Buffer {
  return crypto
    .createHmac("sha256", Buffer.from(hostBearer, "utf8"))
    .update(PROOF_LABEL)
    .digest();
}

/** The proof for one EndpointId under one loopback bearer. */
export function forwardIdentityProof(
  hostBearer: string,
  endpointId: string
): string {
  return crypto
    .createHmac("sha256", forwardKey(hostBearer))
    .update(endpointId, "utf8")
    .digest("hex");
}

/**
 * The headers a forwarder stamps on the hop, in one place so the JS relay and
 * the Rust byte pump's control plane cannot drift into naming devices
 * differently.
 *
 * The forwarded mark stays: host-ONLY capabilities must keep refusing this
 * hop. Saying "this is not the host" and saying who it is instead are two
 * different facts, and the gateway needs both.
 */
export function forwardIdentityHeaders(
  hostBearer: string,
  endpointId: string
): Record<string, string> {
  return {
    [DEVICE_IDENTITY_HEADER]: endpointId,
    [DEVICE_PROOF_HEADER]: forwardIdentityProof(hostBearer, endpointId),
    [TUNNEL_FORWARDED_HEADER]: "1",
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * The EndpointId a forwarded hop proves, or `undefined`.
 *
 * `undefined` is a refusal the caller must honour by refusing the request —
 * never by falling back to an ambient identity, which is exactly the bug this
 * exists to close. The peer lane is excluded up front: a linked gateway's
 * forwarder also delivers to loopback, and a link's reach is the peer plane
 * or nothing (#726, trap 2).
 */
export function forwardedDeviceIdentity(
  hostBearer: string | undefined,
  headers: Readonly<Record<string, string | string[] | undefined>>
): string | undefined {
  if (headerValue(headers[PEER_ENDPOINT_HEADER]) !== undefined)
    return undefined;
  const endpointId = headerValue(headers[DEVICE_IDENTITY_HEADER]);
  const proof = headerValue(headers[DEVICE_PROOF_HEADER]);
  if (!endpointId || !proof || !hostBearer) return undefined;
  const expected = Buffer.from(
    forwardIdentityProof(hostBearer, endpointId),
    "utf8"
  );
  const presented = Buffer.from(proof, "utf8");
  if (presented.length !== expected.length) return undefined;
  return crypto.timingSafeEqual(presented, expected) ? endpointId : undefined;
}
