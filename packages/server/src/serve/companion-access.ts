// THE COMPANION BOUNDARY (#505, re-homed by #928 A6): which surfaces a
// constrained Companion device may reach, and which requests that allows.
//
// The ANSWER is `share_authority` rows in the vault — principal `device`,
// subject type `app.surface`. The gateway authorizes before it opens any
// vault, so it reads a PROJECTION of those rows, rebuilt here on every mount
// and on every write of the answer. An attenuated device with nothing
// projected is REFUSED: confined to a set nobody can read is not full reach.

import type { IncomingMessage } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { listCompanionSurfaces, setCompanionSurfaces } from "@centraid/vault";

export interface CompanionProjectionStore {
  attenuatedEndpointsFor: (vaultId: string) => string[];
  projectSurfaces: (
    endpointId: string,
    vaultId: string,
    surfaces: readonly string[]
  ) => void;
}

export interface CompanionVault {
  db: { vault: DatabaseSync };
  boot: { vaultId: string };
}

/** Re-project every attenuated device's answer for one vault, so a projection
 *  can never outlive the rows it mirrors. */
export function projectCompanionAttenuation(
  store: CompanionProjectionStore,
  plane: CompanionVault
): number {
  const answers = listCompanionSurfaces(plane.db.vault);
  let projected = 0;
  for (const endpointId of store.attenuatedEndpointsFor(plane.boot.vaultId)) {
    store.projectSurfaces(
      endpointId,
      plane.boot.vaultId,
      answers.get(endpointId) ?? []
    );
    projected += 1;
  }
  return projected;
}

/** Write the answer, then the projection of it — never the other way round. */
export function recordCompanionAttenuation(
  store: CompanionProjectionStore,
  plane: CompanionVault,
  input: { endpointId: string; surfaces: readonly string[]; now: string }
): void {
  setCompanionSurfaces(plane.db.vault, {
    deviceId: input.endpointId,
    surfaces: input.surfaces,
    now: input.now,
  });
  store.projectSurfaces(input.endpointId, plane.boot.vaultId, input.surfaces);
}

export type CompanionAccess =
  | { readonly kind: "unattenuated" }
  | { readonly kind: "allowed"; readonly surfaces: readonly string[] }
  /** The device is confined and nothing has been projected — refuse. */
  | { readonly kind: "unreadable" }
  | { readonly kind: "refused" };

/** The boundary decision, in one place so failing closed is a case. */
export function companionAccess(input: {
  attenuated: boolean;
  projected: readonly string[] | undefined;
  req: Pick<IncomingMessage, "method" | "url">;
  enrollmentId: string;
}): CompanionAccess {
  if (!input.attenuated) return { kind: "unattenuated" };
  if (input.projected === undefined) return { kind: "unreadable" };
  return companionRequestAllowed(input.req, input.projected, input.enrollmentId)
    ? { kind: "allowed", surfaces: input.projected }
    : { kind: "refused" };
}

/** Constrained Companion devices reach only pinned tools, status, and self-revocation. */
export function companionRequestAllowed(
  req: Pick<IncomingMessage, "method" | "url">,
  grants: readonly string[],
  enrollmentId: string
): boolean {
  const pathname = new URL(req.url ?? "/", "http://gateway.local").pathname;
  const method = (req.method ?? "GET").toUpperCase();
  const selfRevokePath = `/centraid/_gateway/devices/${encodeURIComponent(enrollmentId)}`;
  // The pinned app RPC surface: an action or query invocation on a granted
  // module (#505). The per-operation allowlist is enforced separately
  // by the runtime's `companionHandlerAllowed` gate.
  const appRpc =
    method === "POST" &&
    /^\/centraid\/[^_/][^/]*\/(?:actions|queries)\/[^/]+$/u.test(pathname);
  return (
    appRpc ||
    pathname === "/centraid/_vault/status" ||
    pathname === "/centraid/_vault/apps" ||
    pathname === "/centraid/_vault/blocking" ||
    (pathname === selfRevokePath &&
      (req.method ?? "GET").toUpperCase() === "DELETE") ||
    (pathname === "/centraid/_vault/blobs" &&
      (req.method ?? "GET").toUpperCase() === "POST" &&
      grants.includes("docs"))
  );
}
