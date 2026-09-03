import { PEER_MIN_PROTOCOL_VERSION, PEER_PROTOCOL_VERSION } from "./version.js";

export interface PeerHello {
  peerProtocolVersion: number;
  minPeerProtocol: number;
}

export type PeerHandshakeVerdict =
  | { state: "ok"; hello: PeerHello }
  | { state: "bad_request"; detail: string }
  | {
      state: "protocol_refused";
      hello: PeerHello;
      localProtocolVersion: number;
      localMinProtocol: number;
      detail: string;
    };

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

export function peerProtocolsCompatible(hello: PeerHello): boolean {
  return (
    hello.peerProtocolVersion >= PEER_MIN_PROTOCOL_VERSION &&
    PEER_PROTOCOL_VERSION >= hello.minPeerProtocol
  );
}

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
