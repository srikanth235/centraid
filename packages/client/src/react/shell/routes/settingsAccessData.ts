/**
 * Settings → Access, the desktop seat's readers (#883, ruling V-dashboard).
 *
 * The dashboard itself — its grouping, its parsers, its two rules — is
 * `@centraid/client/access-lens`, shared with the phone. This file is the whole
 * of the seat difference: which replica session the rows come from, and which
 * transport the vault's per-locus sentences come from.
 */

import type {
  AccessReader,
  AccessRegistryReader,
} from "../../../access-lens.js";

export * from "../../../access-lens.js";

/**
 * The shell's own registry reader: the grant plane's wire calls, addressed and
 * credentialed by the browser seat's own adapter.
 */
export async function accessRegistryReader(): Promise<AccessRegistryReader> {
  const { grantBridge } = await import("../../blueprints/grant-seat.js");
  return grantBridge(() => window.CentraidApi.getGatewayAuth());
}

/**
 * The shell's own reader: the seat's page, over this browser's copy of the
 * vault (#996 wave 5, R8). `ReplicaShellSession.page` is POSITIONAL and the
 * walk takes one request object, so this is where the two are adapted — the
 * same difference the phone's own ctx builder carries.
 *
 * A SEAT WITH NO COPY REFUSES, and the dashboard draws `unreadable` with that
 * refusal's own sentence. "We could not ask" and "nobody has access" are
 * opposite facts, and this is the one that is true.
 */
export async function accessReader(): Promise<AccessReader> {
  const { getReplicaShellSession } =
    await import("../../../replica/shell-session.js");
  const session = await getReplicaShellSession();
  return {
    page: (request) =>
      session.page(
        request.query,
        {
          limit: request.limit,
          ...(request.after ? { after: request.after } : {}),
        },
        request.overlay
      ),
  };
}
