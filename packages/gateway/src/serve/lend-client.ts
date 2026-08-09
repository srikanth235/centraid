/*
 * The dialing half of a live edge (#726 P4). Direction-free like every other
 * peer client in this package: the ORIGIN runs `openLendOverPeer` and
 * `closeLendOverPeer`, the AUDIENCE runs `peerLendPull` and the same
 * `closeLendOverPeer` — one frame, two readings, which is exactly why
 * "the lender revoked" and "the borrower dropped it" need no separate
 * machinery.
 *
 * Transport is injected (`PeerDial`); nothing here knows about iroh.
 */

import {
  PEER_LEND_BOOTSTRAP_PATH,
  PEER_LEND_CHANGES_PATH,
  PEER_LEND_CLOSE_PATH,
  PEER_LEND_INTENT_PATH,
  PEER_LEND_OPEN_PATH,
} from "../routes/peer-lend-route.js";
import type { LendPull } from "./lend-audience.js";
import type { LendIntentFrame, LendIntentRequest } from "./lend-intent.js";
import { parseLease } from "./lend-lease.js";
import type { LendLease } from "./lend-lease.js";
import type { PeerDial, PeerDialRoute } from "./peer-edge-give-client.js";

export type OpenLendResult =
  | { state: "opened" }
  | { state: "not_found" }
  | { state: "bad_request"; detail: string }
  | { state: "unreachable"; detail: string };

export async function openLendOverPeer(input: {
  dial: PeerDial;
  route: PeerDialRoute;
  edgeId: string;
  itemType: string;
  verbs: "read" | "read+act";
  lease: LendLease;
}): Promise<OpenLendResult> {
  let response: { status: number; json: unknown };
  try {
    response = await input.dial.request({
      endpointTicket: input.dial.endpointTicketFor(
        input.route.endpointId,
        input.route.relayHints
      ),
      method: "POST",
      target: PEER_LEND_OPEN_PATH,
      body: {
        edgeId: input.edgeId,
        itemType: input.itemType,
        verbs: input.verbs,
        lease: input.lease,
      },
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
  if (body.state === "opened") return { state: "opened" };
  if (response.status === 404 || body.state === "not_found")
    return { state: "not_found" };
  return {
    state: "bad_request",
    detail:
      typeof body.state === "string"
        ? `unexpected peer state: ${body.state}`
        : "malformed peer answer",
  };
}

/**
 * The audience's puller, as a {@link LendPull}. A thrown transport error is
 * left to throw here on purpose — the caller (`syncBorrowedEdge`) turns it
 * into an `unreachable` OUTCOME, and a borrowed shape is never dropped merely
 * because a peer was offline. Only a lease running out does that.
 */
export function peerLendPull(input: {
  dial: PeerDial;
  route: PeerDialRoute;
}): LendPull {
  return async (request) => {
    const query = new URLSearchParams({ edgeId: request.edgeId });
    let target: string;
    if (request.frame === "bootstrap") {
      query.set("entityIdx", String(request.position?.entityIdx ?? 0));
      if (request.position?.after) query.set("after", request.position.after);
      target = `${PEER_LEND_BOOTSTRAP_PATH}?${query.toString()}`;
    } else {
      query.set("epoch", request.since?.epoch ?? "");
      query.set("seq", String(request.since?.seq ?? 0));
      target = `${PEER_LEND_CHANGES_PATH}?${query.toString()}`;
    }
    const response = await input.dial.request({
      endpointTicket: input.dial.endpointTicketFor(
        input.route.endpointId,
        input.route.relayHints
      ),
      method: "GET",
      target,
    });
    return response.json;
  };
}

export type PushLendIntentResult =
  | { state: "answered"; frame: LendIntentFrame; lease: LendLease }
  | { state: "not_found" }
  | { state: "unreachable"; detail: string };

/**
 * Push one queued intent to the origin (#726 P5). The SAME frame this
 * function POSTs answers a first attempt, a retry after a dropped
 * connection, and a later poll for a parked invocation — the caller
 * (`lend-audience.ts::drainBorrowedIntents`) does not need to know which one
 * it is asking for.
 */
export async function pushLendIntentOverPeer(input: {
  dial: PeerDial;
  route: PeerDialRoute;
  edgeId: string;
  request: LendIntentRequest;
}): Promise<PushLendIntentResult> {
  let response: { status: number; json: unknown };
  try {
    response = await input.dial.request({
      endpointTicket: input.dial.endpointTicketFor(
        input.route.endpointId,
        input.route.relayHints
      ),
      method: "POST",
      target: PEER_LEND_INTENT_PATH,
      body: { edgeId: input.edgeId, ...input.request },
    });
  } catch (error) {
    return {
      state: "unreachable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (response.status === 404) return { state: "not_found" };
  const body =
    response.json !== null && typeof response.json === "object"
      ? (response.json as Record<string, unknown>)
      : {};
  const state = typeof body.state === "string" ? body.state : undefined;
  const lease = parseLease(body.lease);
  if (!state || !lease) {
    return {
      state: "unreachable",
      detail: "malformed peer answer",
    };
  }
  return {
    state: "answered",
    frame: body as unknown as LendIntentFrame,
    lease,
  };
}

/** Tell the other side the window is shut. Best effort by construction: the
 *  local half of the close has already happened before this is called. */
export async function closeLendOverPeer(input: {
  dial: PeerDial;
  route: PeerDialRoute;
  edgeId: string;
}): Promise<{ state: "closed" | "not_found" | "unreachable" }> {
  try {
    const response = await input.dial.request({
      endpointTicket: input.dial.endpointTicketFor(
        input.route.endpointId,
        input.route.relayHints
      ),
      method: "POST",
      target: PEER_LEND_CLOSE_PATH,
      body: { edgeId: input.edgeId },
    });
    const body =
      response.json !== null && typeof response.json === "object"
        ? (response.json as Record<string, unknown>)
        : {};
    return { state: body.state === "closed" ? "closed" : "not_found" };
  } catch {
    return { state: "unreachable" };
  }
}
