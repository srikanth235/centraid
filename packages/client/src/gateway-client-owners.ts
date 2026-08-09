/*
 * Renderer-side client for the gateway's owner surface (issue #726 —
 * `packages/gateway/src/routes/owners-routes.ts`, formerly `members-routes.ts`).
 * Backs the Devices card's own-person header and the profile rename flow.
 *
 *   GET    /centraid/_gateway/owners
 *   PATCH  /centraid/_gateway/owners/<ownerId> {label}
 *
 * An owner is the principal device bindings attach to; a vault has exactly
 * one owner, and access IS ownership — there are no roles left to carry.
 * Scope is the caller's own person: a device caller sees and renames only
 * its own owner, because one owner per vault means there is no roster of
 * other people a device is entitled to (topology hiding, re-aimed).
 *
 * Creating or removing a PERSON is the host-custody (L0) lane on this
 * gateway — a device caller always gets refused, so those verbs have no
 * client here. *Add someone* mints a person their own vault in a later
 * phase (#726 P1); until then the invite lane is self-pair only
 * (`gateway-client-devices.ts`'s `createGatewayDeviceTicket`).
 *
 * A gateway with no device plane (the desktop embed) has no owner surface —
 * those routes 404, which `listGatewayOwners` reports as an empty roster,
 * matching `listGatewayDevices`.
 */

import {
  auth,
  authHeaders,
  doFetch,
  enc,
  readJson,
  GatewayClientError,
} from "./gateway-client-core.js";

/** One vault the owner holds — mirrors `gateway-client-devices.ts`'s. */
export interface GatewayOwnerVault {
  vaultId: string;
  vaultName?: string;
}

/** The caller's own person (mirrors the gateway route's owner DTO). */
export interface GatewayOwner {
  ownerId: string;
  /** Owner-facing name. Renaming never changes the id, so history survives. */
  label: string;
  createdAt: string;
  /** Every vault this person owns, with the resolved vault name. */
  vaults: GatewayOwnerVault[];
  /** Live (non-tombstoned) devices bound to this person. */
  deviceCount: number;
}

/** The caller's own person, alone in the array; `[]` when the gateway has no device plane. */
export async function listGatewayOwners(): Promise<GatewayOwner[]> {
  const { baseUrl, token } = await auth();
  try {
    const res = await doFetch(baseUrl, "/centraid/_gateway/owners", {
      method: "GET",
      headers: authHeaders(token),
    });
    const out = await readJson<{ owners: GatewayOwner[] }>(res, "list owners");
    return out.owners ?? [];
  } catch (error) {
    if (error instanceof GatewayClientError && error.code === "not_found")
      return [];
    throw error;
  }
}

/** Rename the caller's own person. The id is untouched, so every binding and
 *  attribution survives the rename. */
export async function renameGatewayOwner(
  ownerId: string,
  label: string
): Promise<GatewayOwner> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_gateway/owners/${enc(ownerId)}`,
    {
      method: "PATCH",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify({ label }),
    }
  );
  return (await readJson<{ owner: GatewayOwner }>(res, "rename owner")).owner;
}
