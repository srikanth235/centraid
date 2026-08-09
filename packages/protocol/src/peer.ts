/*
 * Peer (gateway↔gateway) handshake (issue #726 P3 decision 5).
 *
 * The C1 two-contract shape, applied to the link plane:
 *   1. PARSE always succeeds — a malformed hello becomes the `bad_request`
 *      state, never a thrown error rendered to an owner as an answer;
 *   2. then the CAPABILITY check — the mutual support window;
 *   3. then either the feature runs, or one update wall.
 *
 * The window is mutual on purpose. "Their version is newer" is not a refusal
 * reason; "neither of us can speak anything the other still supports" is.
 */

import { PEER_MIN_PROTOCOL_VERSION, PEER_PROTOCOL_VERSION } from "./version.js";

/** What each side sends first on a link dial. */
export interface PeerHello {
  peerProtocolVersion: number;
  minPeerProtocol: number;
}

export type PeerHandshakeVerdict =
  | { state: "ok"; hello: PeerHello }
  | { state: "bad_request"; detail: string }
  | {
      state: "protocol_refused";
      /** What the far side offered — surfaced so the wall can name a side. */
      hello: PeerHello;
      localProtocolVersion: number;
      localMinProtocol: number;
      detail: string;
    };

/** This gateway's half of the exchange. */
export function peerHello(): PeerHello {
  return {
    peerProtocolVersion: PEER_PROTOCOL_VERSION,
    minPeerProtocol: PEER_MIN_PROTOCOL_VERSION,
  };
}

function readInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

/**
 * Mutual support window:
 *   peer.protocolVersion >= local.min  AND  local.protocolVersion >= peer.min
 */
export function peerProtocolsCompatible(hello: PeerHello): boolean {
  return (
    hello.peerProtocolVersion >= PEER_MIN_PROTOCOL_VERSION &&
    PEER_PROTOCOL_VERSION >= hello.minPeerProtocol
  );
}

/** Judge a far gateway's hello. Total: every input maps to a state. */
export function judgePeerHandshake(raw: unknown): PeerHandshakeVerdict {
  if (raw === null || typeof raw !== "object") {
    return { state: "bad_request", detail: "peer hello was not an object" };
  }
  const candidate = raw as Record<string, unknown>;
  const peerProtocolVersion = readInteger(candidate.peerProtocolVersion);
  if (peerProtocolVersion === undefined) {
    return {
      state: "bad_request",
      detail: "peer hello missing peerProtocolVersion",
    };
  }
  // A peer that names no floor supports exactly what it speaks; assuming a
  // wider window on its behalf is how a silent degrade starts.
  const minPeerProtocol =
    readInteger(candidate.minPeerProtocol) ?? peerProtocolVersion;
  const hello: PeerHello = { peerProtocolVersion, minPeerProtocol };
  if (minPeerProtocol > peerProtocolVersion) {
    return {
      state: "bad_request",
      detail: "peer hello floor exceeds its own version",
    };
  }
  if (!peerProtocolsCompatible(hello)) {
    return {
      state: "protocol_refused",
      hello,
      localProtocolVersion: PEER_PROTOCOL_VERSION,
      localMinProtocol: PEER_MIN_PROTOCOL_VERSION,
      detail:
        `peer link protocol ${peerProtocolVersion} (floor ${minPeerProtocol}) ` +
        `cannot meet this gateway's ${PEER_PROTOCOL_VERSION} (floor ` +
        `${PEER_MIN_PROTOCOL_VERSION}). The older gateway must update; a link ` +
        "is never downgraded to keep working.",
    };
  }
  return { state: "ok", hello };
}
