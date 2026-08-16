/*
 * The dialing half of a remote give (#726 P3 decision 7). Direction-free the
 * same way `peer-link-client.ts` is: this module is what the ORIGIN runs to
 * push a closure, and — for the D9 'ask' resume — what the AUDIENCE runs to
 * pull one back after its owner answers. Transport is injected exactly like
 * the link ceremony's `PeerRequest`; nothing here knows about iroh.
 */

import type { ProjectedItem, WireClosure } from "@centraid/vault";

import type { WireDerivativeBlob } from "./peer-closure-blobs.js";
import type { PeerRequest } from "./peer-link-client.js";

export const PEER_EDGE_GIVE_PATH = "/centraid/_peer/edge/give";
export const PEER_EDGE_CLOSURE_PATH_PREFIX = "/centraid/_peer/edge/closure/";
export const PEER_EDGE_DENY_PATH = "/centraid/_peer/edge/deny";

/** Local only: the one caller is `pullEdgeClosure` below, and the peer plane
 *  matches the PREFIX rather than rebuilding a path it never dials. */
function peerEdgeClosurePath(edgeId: string): string {
  return `${PEER_EDGE_CLOSURE_PATH_PREFIX}${encodeURIComponent(edgeId)}`;
}

export interface PeerDialRoute {
  endpointId: string;
  relayHints: string[];
}

export interface PeerDial {
  request: PeerRequest;
  endpointTicketFor: (endpointId: string, relayHints: string[]) => string;
}

export type GiveOverPeerResult =
  | { state: "given"; items: ProjectedItem[] }
  /** D9 'ask': parked at the audience, nothing written, awaiting its owner. */
  | { state: "asked" }
  /** D9 'refuse': terminal. Reaches forward only — never says why. */
  | { state: "denied"; reason?: string }
  | { state: "not_found" }
  | { state: "bad_request"; detail: string }
  | { state: "unreachable"; detail: string };

function readItems(body: Record<string, unknown>): ProjectedItem[] | undefined {
  if (!Array.isArray(body.items)) return undefined;
  return body.items as ProjectedItem[];
}

function interpretGiveAnswer(
  status: number,
  json: unknown
): GiveOverPeerResult {
  const body =
    json !== null && typeof json === "object"
      ? (json as Record<string, unknown>)
      : {};
  if (body.state === "not_found" || status === 404)
    return { state: "not_found" };
  if (body.state === "denied") {
    return {
      state: "denied",
      ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
    };
  }
  if (body.state === "asked") return { state: "asked" };
  if (body.state === "given") {
    const items = readItems(body);
    if (items) return { state: "given", items };
  }
  return {
    state: "bad_request",
    detail:
      typeof body.state === "string"
        ? `unexpected peer state: ${body.state}`
        : "malformed peer answer",
  };
}

export interface GiveEdgeOverPeerInput {
  dial: PeerDial;
  route: PeerDialRoute;
  edgeId: string;
  itemType: string;
  itemCount: number;
  closure: WireClosure;
  derivatives: readonly WireDerivativeBlob[];
}

/** Push a closure (plus its derivative bytes) to the audience over the peer plane. */
export async function giveEdgeOverPeer(
  input: GiveEdgeOverPeerInput
): Promise<GiveOverPeerResult> {
  let response: { status: number; json: unknown };
  try {
    response = await input.dial.request({
      endpointTicket: input.dial.endpointTicketFor(
        input.route.endpointId,
        input.route.relayHints
      ),
      method: "POST",
      target: PEER_EDGE_GIVE_PATH,
      body: {
        edgeId: input.edgeId,
        itemType: input.itemType,
        itemCount: input.itemCount,
        closure: input.closure,
        derivatives: input.derivatives,
      },
    });
  } catch (error) {
    return {
      state: "unreachable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  return interpretGiveAnswer(response.status, response.json);
}

export interface PullEdgeClosureResult {
  closure: WireClosure;
  derivatives: readonly WireDerivativeBlob[];
}

export type PullEdgeClosureOutcome =
  | ({ state: "given" } & PullEdgeClosureResult)
  | { state: "not_found" }
  | { state: "bad_request"; detail: string }
  | { state: "unreachable"; detail: string };

/** Fetch a closure back from the origin — the D9 'ask' → accept resume. */
export async function pullEdgeClosure(input: {
  dial: PeerDial;
  route: PeerDialRoute;
  edgeId: string;
}): Promise<PullEdgeClosureOutcome> {
  let response: { status: number; json: unknown };
  try {
    response = await input.dial.request({
      endpointTicket: input.dial.endpointTicketFor(
        input.route.endpointId,
        input.route.relayHints
      ),
      method: "GET",
      target: peerEdgeClosurePath(input.edgeId),
    });
  } catch (error) {
    return {
      state: "unreachable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const body =
    response.json !== null && typeof response.json === "object"
      ? (response.json as Record<string, unknown>)
      : {};
  if (body.state === "not_found" || response.status === 404) {
    return { state: "not_found" };
  }
  if (
    body.state === "given" &&
    body.closure !== null &&
    typeof body.closure === "object" &&
    Array.isArray(body.derivatives)
  ) {
    return {
      state: "given",
      closure: body.closure as WireClosure,
      derivatives: body.derivatives as WireDerivativeBlob[],
    };
  }
  return { state: "bad_request", detail: "malformed peer answer" };
}

export type DenyEdgeOverPeerOutcome =
  | { state: "acknowledged" }
  | { state: "not_found" }
  | { state: "bad_request"; detail: string }
  | { state: "unreachable"; detail: string };

/**
 * Tell the origin a D9 'ask' was refused (#726 P3 decision 9). Reaches
 * FORWARD only — the origin learns its edge was denied and nothing else:
 * no counts, no reasons that describe other content, no existence
 * information about other vaults. Called from the share outbox's
 * `deliver-refusal` handler (`share-effect-executor.ts`), never from the
 * answer route itself, so an unreachable origin never blocks the answer.
 */
export async function denyEdgeOverPeer(input: {
  dial: PeerDial;
  route: PeerDialRoute;
  edgeId: string;
}): Promise<DenyEdgeOverPeerOutcome> {
  let response: { status: number; json: unknown };
  try {
    response = await input.dial.request({
      endpointTicket: input.dial.endpointTicketFor(
        input.route.endpointId,
        input.route.relayHints
      ),
      method: "POST",
      target: PEER_EDGE_DENY_PATH,
      body: { edgeId: input.edgeId },
    });
  } catch (error) {
    return {
      state: "unreachable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const body =
    response.json !== null && typeof response.json === "object"
      ? (response.json as Record<string, unknown>)
      : {};
  if (body.state === "not_found" || response.status === 404) {
    return { state: "not_found" };
  }
  if (body.state === "acknowledged") return { state: "acknowledged" };
  return {
    state: "bad_request",
    detail:
      typeof body.state === "string"
        ? `unexpected peer state: ${body.state}`
        : "malformed peer answer",
  };
}
