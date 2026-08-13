/*
 * `GET /centraid/_peer/blob/chunk` — the ORIGIN side of a remote give's
 * background byte pull (#726 P3 decision 7). Ranged, JSON-framed like every
 * other peer-plane frame: `?sha256=&offset=&length=` in, one base64 chunk
 * out. The audience loops this until it has the whole original, verifying
 * the concatenated bytes against `sha256` itself before adopting them — this
 * route only ever answers what was asked for, never attests to the whole.
 *
 * A GET, deliberately (wire-deltas.md "P3 transport"): the forwarder caps
 * INBOUND request bodies at 32MiB but streams response bodies uncapped, so
 * the audience always PULLS bytes rather than the origin pushing them.
 */

import type { ServerResponse } from "node:http";

import type { LocalBlobStore } from "@centraid/vault";

import type { GatewayDatabase } from "../serve/gateway-db.js";
import { hasGivenEdge } from "../serve/peer-give-authorization.js";
import { readEdgeRow } from "../serve/share-edge-row.js";
import type { PeerIdentity } from "./peer-plane.js";
import { sendJson } from "./route-helpers.js";

export interface PeerBlobRouteDeps {
  gatewayDatabase: GatewayDatabase;
  blobsFor: (vaultId: string) => LocalBlobStore | undefined;
}

function parsePositiveInt(raw: string | null): number | undefined {
  if (raw === null || raw.length === 0) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function handlePeerBlobChunk(
  res: ServerResponse,
  peer: PeerIdentity,
  query: URLSearchParams,
  deps: PeerBlobRouteDeps
): true {
  if (!peer.linked) return sendJson(res, 404, { state: "not_found" });
  const sha256 = query.get("sha256");
  const offset = parsePositiveInt(query.get("offset"));
  const length = parsePositiveInt(query.get("length"));
  const edgeId = query.get("edgeId");
  if (
    !sha256 ||
    !/^[0-9a-f]{64}$/u.test(sha256) ||
    offset === undefined ||
    length === undefined ||
    length === 0 ||
    !edgeId
  ) {
    return sendJson(res, 400, { state: "bad_request" });
  }
  // The edge row is THIS gateway's own trusted bookkeeping — it already names
  // BOTH vaults, so the exact pair resolves the link precisely (audit #726
  // finding 2: an endpoint alone cannot disambiguate two vaults co-hosted on
  // one remote gateway, and a remote-vault claim alone cannot disambiguate
  // two LOCAL vaults linked to the same remote one).
  //
  const row = readEdgeRow(deps.gatewayDatabase, edgeId);
  if (!row) return sendJson(res, 404, { state: "not_found" });
  const link = peer.linkForPair(row.origin_vault_id, row.audience_vault_id);
  if (!link) return sendJson(res, 404, { state: "not_found" });
  // A peer may only pull bytes this gateway has actually GIVEN it — not any
  // sha it happens to know, and never from a vault it isn't linked to.
  if (
    !hasGivenEdge(deps.gatewayDatabase, link.localVaultId, link.peerVaultId)
  ) {
    return sendJson(res, 404, { state: "not_found" });
  }
  const store = deps.blobsFor(link.localVaultId);
  const stat = store?.statSync(sha256);
  if (!store || !stat) return sendJson(res, 404, { state: "not_found" });
  if (offset > stat.size) return sendJson(res, 400, { state: "bad_request" });
  const end = Math.min(offset + length, stat.size) - 1;
  const bytes =
    offset >= stat.size
      ? Buffer.alloc(0)
      : store.getSync(sha256, { start: offset, end });
  if (bytes === null) return sendJson(res, 404, { state: "not_found" });
  return sendJson(res, 200, {
    state: "chunk",
    sha256,
    offset,
    length: bytes.length,
    totalSize: stat.size,
    bytes: bytes.toString("base64"),
  });
}
