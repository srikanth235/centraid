// The `lend()`/`links()` wire glue `centraid-inline.ts` needs (#726 P6),
// extracted to keep that file under the 500-line cap — same split as
// `placement-wire.ts` did for `place()`.
//
// `lend()` opens a LIVE edge (`mode: "live"`, D8's leased window) instead of
// copying a fixed item set; `links()` lists the household's cross-vault links
// (`/centraid/_gateway/links`) so a blueprint's share sheet can offer "linked
// people" as destinations alongside the member's own other vaults, with no
// distinction drawn between a co-hosted and a remote peer (D3: locality is
// routing, not semantics).
import { ROUTES } from "@centraid/protocol";

import { authHeaders, doFetch, readJson } from "../../gateway-client-core.js";
import type { GatewayAuth } from "../../gateway-client-core.js";
import { listGatewayLinks } from "../../gateway-client-links.js";
import type { GatewayLink } from "../../gateway-client-links.js";
import { toPlacementStatus } from "./placement-wire.js";

/** One scope declaration a live edge lends — the SAME shape
 *  `consent_grant_scope` stores (`edges-routes.ts`'s `LendScope`). */
export interface InlineLendScope {
  schema: string;
  table?: string;
  rowFilter?: Array<{ column: string; op: string; value?: unknown }>;
  fieldMask?: string[];
}

/** One lent scope's mask-selection-time search reach (#726 P4 D10) — the
 *  same shape the gateway's `ScopeSearchReach`
 *  (`packages/gateway/src/serve/lend-search-reach.ts`) puts on `edgeWire`'s
 *  `searchReach` field, restated here rather than imported: the client
 *  package does not depend on the gateway's server-side modules. Mirrors
 *  `packages/blueprints/apps/_shared/share-kit.ts`'s `LendSearchReach`,
 *  which restates it a second time for the same reason one step further out
 *  (blueprint apps are unbundled browser ES modules and cannot import from
 *  either the gateway or this package). */
export interface InlineSearchReach {
  schema: string;
  table: string;
  masksSearchableColumns: boolean;
}

export interface InlineLendResult {
  linkToken: string;
  itemType: string;
  sourceVaultId: string;
  targetVaultId: string;
  status: string;
  reason?: string;
  accessReceiptId?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
  /** Present only when the gateway computed it for a live edge (#726 P4 D10)
   *  — a scope with `masksSearchableColumns: true` will refuse a search over
   *  its excluded columns rather than silently under-searching. */
  searchReach?: InlineSearchReach[];
}

/** Structural check, not a schema validator: `edge.searchReach` is untyped
 *  JSON off the wire, so this only confirms the shape `InlineSearchReach`
 *  promises before handing it to a caller as typed data. */
function isSearchReachArray(value: unknown): value is InlineSearchReach[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { schema?: unknown }).schema === "string" &&
        typeof (entry as { table?: unknown }).table === "string" &&
        typeof (entry as { masksSearchableColumns?: unknown })
          .masksSearchableColumns === "boolean"
    )
  );
}

/** Fold one `/edges` `mode: "live"` response back into the same wire shape
 *  `place()`'s callers already read — `status`/`reason`/`accessReceiptId`. */
export function lendWireFromEdge(
  edge: Record<string, unknown>,
  opts: {
    linkToken: string;
    itemType: string;
    sourceVaultId: string;
    targetVaultId: string;
  }
): InlineLendResult {
  return {
    linkToken: opts.linkToken,
    itemType: opts.itemType,
    sourceVaultId: opts.sourceVaultId,
    targetVaultId: opts.targetVaultId,
    status: toPlacementStatus(edge.status),
    ...(typeof edge.reason === "string" ? { reason: edge.reason } : {}),
    ...(typeof edge.accessReceiptId === "string"
      ? { accessReceiptId: edge.accessReceiptId }
      : {}),
    ...(isSearchReachArray(edge.searchReach)
      ? { searchReach: edge.searchReach }
      : {}),
    createdAt: edge.createdAt,
    updatedAt: edge.updatedAt,
  };
}

/** Open a live edge and shape the response — the whole body of
 *  `centraid-inline.ts`'s `lend()`, extracted so that file stays a thin
 *  dispatcher (file-size norm). */
export async function performLend(
  auth: GatewayAuth,
  opts: {
    linkToken: string;
    itemType: string;
    scopes: InlineLendScope[];
    sourceVaultId: string;
    targetVaultId: string;
  }
): Promise<InlineLendResult> {
  const response = await doFetch(auth.baseUrl, ROUTES.gatewayEdges, {
    method: "POST",
    headers: authHeaders(auth.token, "application/json"),
    body: JSON.stringify({
      edgeId: opts.linkToken,
      originVaultId: opts.sourceVaultId,
      audienceVaultId: opts.targetVaultId,
      mode: "live",
      kind: "add",
      itemType: opts.itemType,
      scopes: opts.scopes,
      verbs: "read",
    }),
  });
  const edge = await readJson<Record<string, unknown>>(response, "lend scope");
  return lendWireFromEdge(edge, {
    linkToken: opts.linkToken,
    itemType: opts.itemType,
    sourceVaultId: opts.sourceVaultId,
    targetVaultId: opts.targetVaultId,
  });
}

/** One linked vault a share sheet may offer as a destination — a person, not
 *  a place: co-hosted and remote links answer identically (D3). */
export interface InlineLinkDestination {
  linkId: string;
  vaultId: string;
  approved: boolean;
}

/**
 * The OTHER side of every approved, non-revoked link touching `ownVaultId` —
 * candidate lend/give destinations beyond the member's own mounted scopes.
 * Unapproved links are excluded: proposing one is not yet an authorization
 * (`judgeEdgeCrossing` would refuse an edge against it anyway), so offering it
 * as a destination would be a control that fires and then fails.
 */
export function linkDestinationsFor(
  links: readonly GatewayLink[],
  ownVaultId: string
): InlineLinkDestination[] {
  const out: InlineLinkDestination[] = [];
  for (const link of links) {
    if (link.revoked || !link.approved) continue;
    const other =
      link.vaultA === ownVaultId
        ? link.vaultB
        : link.vaultB === ownVaultId
          ? link.vaultA
          : undefined;
    if (other)
      out.push({ linkId: link.linkId, vaultId: other, approved: true });
  }
  return out;
}

/** Fetch + filter in one call — the shape `centraid-inline.ts`'s `links()`
 *  hands the app. Never throws: a gateway with no link plane (or a transient
 *  failure) answers an empty list, the same "degrade to nothing offered"
 *  posture `place()`'s destination lists already take. */
export async function loadLinkDestinations(
  ownVaultId: string
): Promise<InlineLinkDestination[]> {
  try {
    const links = await listGatewayLinks();
    return linkDestinationsFor(links, ownVaultId);
  } catch {
    return [];
  }
}
