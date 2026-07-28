/*
 * Renderer-side client for the household roster (issue #599 L2 —
 * `packages/gateway/src/routes/members-routes.ts`). Backs the people-first
 * Devices card and the member picker in the pairing panel.
 *
 *   GET    /centraid/_gateway/members
 *   POST   /centraid/_gateway/members            {label}
 *   PATCH  /centraid/_gateway/members/<memberId> {label}
 *   DELETE /centraid/_gateway/members/<memberId> {confirmLastAdmin?}
 *
 * A member is the PRINCIPAL authority is authored on; devices only inherit.
 * That is why the two removal verbs live on different routes: revoking a
 * device (`revokeGatewayDevice`) says "this phone was stolen", while removing
 * a member says "this person is out" and takes every device they own with it.
 *
 * A gateway with no device plane (the desktop embed) has no roster surface —
 * those routes 404, which `listGatewayMembers` reports as an empty roster,
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
import type { GatewayVaultGrant } from "./gateway-client-devices.js";

/** One person in the household (mirrors the gateway route's member DTO). */
export interface GatewayMember {
  memberId: string;
  /** Owner-facing name. Renaming never changes the id, so history survives. */
  label: string;
  createdAt: string;
  /** Every space this person holds a role in, with the resolved space name. */
  roles: GatewayVaultGrant[];
  /** Live (non-tombstoned) devices bound to this person. */
  deviceCount: number;
}

/** Everyone the caller shares a space with; `[]` when the gateway has no device plane. */
export async function listGatewayMembers(): Promise<GatewayMember[]> {
  const { baseUrl, token } = await auth();
  try {
    const res = await doFetch(baseUrl, "/centraid/_gateway/members", {
      method: "GET",
      headers: authHeaders(token),
    });
    const out = await readJson<{ members: GatewayMember[] }>(
      res,
      "list members"
    );
    return out.members ?? [];
  } catch (err) {
    if (err instanceof GatewayClientError && err.code === "not_found")
      return [];
    throw err;
  }
}

/**
 * Add a person to the household. Adding is an ownership act — the gateway
 * refuses (`not_admin`) unless the caller is an owner somewhere. The new
 * member starts with NO roles; a pairing ticket is what grants them.
 */
export async function createGatewayMember(
  label: string
): Promise<GatewayMember> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_gateway/members", {
    method: "POST",
    headers: authHeaders(token, "application/json"),
    body: JSON.stringify({ label }),
  });
  return (await readJson<{ member: GatewayMember }>(res, "add member")).member;
}

/** Rename a person. The id is untouched, so grants and attribution survive. */
export async function renameGatewayMember(
  memberId: string,
  label: string
): Promise<GatewayMember> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_gateway/members/${enc(memberId)}`,
    {
      method: "PATCH",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify({ label }),
    }
  );
  return (await readJson<{ member: GatewayMember }>(res, "rename member"))
    .member;
}

/**
 * Remove a PERSON — one atomic act that drops their grants and every device
 * they own. Removing the last owner of a space 409s until `confirmLastAdmin`
 * echoes that space's name back (the gateway states which one in the error).
 */
export async function removeGatewayMember(
  memberId: string,
  options?: { confirmLastAdmin?: string }
): Promise<{ removed: boolean; memberId: string; devices: number }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_gateway/members/${enc(memberId)}`,
    {
      method: "DELETE",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify(
        options?.confirmLastAdmin
          ? { confirmLastAdmin: options.confirmLastAdmin }
          : {}
      ),
    }
  );
  return readJson<{ removed: boolean; memberId: string; devices: number }>(
    res,
    "remove member"
  );
}
