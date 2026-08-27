import {
  grantDoor,
  GrantUnreachableError,
} from "@centraid/blueprints/apps/_shared/grant-door";
import type {
  GrantDoor,
  GrantWireCalls,
} from "@centraid/blueprints/apps/_shared/grant-door";
import type { GrantRequest } from "@centraid/blueprints/apps/_shared/grant-plane";
// The NATIVE seat's transport into the grant plane (#825); parsing and the
// refusal contract stay in the shared grant-door. Paths come from
// `@centraid/core/protocol`; no literal lives here.
import { ROUTES, vaultGrantRevokePath } from "@centraid/core/protocol";

import { apiHeaders } from "../../lib/gateway";

/** Refusals reject with the route's own message, verbatim. */
async function grantJson(response: Response, op: string): Promise<unknown> {
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text.length ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${op} failed (${response.status})`);
  }
  if (response.ok) return parsed;
  const row = parsed as { message?: unknown; error?: unknown };
  if (typeof row.message === "string" && row.message.length)
    throw new Error(row.message);
  throw new Error(
    typeof row.error === "string" && row.error.length
      ? `${op}: ${row.error}`
      : `${op} failed (${response.status})`
  );
}

function grantsUrl(
  baseUrl: string,
  params?: Record<string, string>
): URL | string {
  const url = new URL(ROUTES.vaultGrants, baseUrl);
  for (const [key, value] of Object.entries(params ?? {}))
    url.searchParams.set(key, value);
  return url;
}

/** A phone is off the network most days it is carried, and `fetch` rejects
 *  rather than answering when the request never left the device. Only THIS
 *  layer knows that, so it marks the error; the door reads the mark instead of
 *  inventing an outage from a message it did not send. */
async function reach(
  send: () => Promise<Response>,
  op: string
): Promise<Response> {
  try {
    return await send();
  } catch (error) {
    throw new GrantUnreachableError(op, error);
  }
}

/** The native seat's calls, in the shape `grantDoor` takes. */
export function nativeGrantCalls(baseUrl: string): GrantWireCalls {
  const get = (url: URL | string, op: string): Promise<Response> =>
    reach(() => fetch(url, { headers: apiHeaders() }), op);
  const post = (
    url: URL | string,
    op: string,
    payload?: unknown
  ): Promise<Response> =>
    reach(
      () =>
        fetch(url, {
          method: "POST",
          headers: apiHeaders(
            payload === undefined ? {} : { "content-type": "application/json" }
          ),
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        }),
      op
    );
  return {
    async subjects() {
      const op = "read shareable subjects";
      return grantJson(
        await get(new URL(ROUTES.vaultGrantSubjects, baseUrl), op),
        op
      );
    },
    async forParty(partyId) {
      const op = "read what this person can reach";
      const response = await get(grantsUrl(baseUrl, { partyId }), op);
      // `audience_not_found` is a real answer, not a failure.
      if (response.status === 404) return undefined;
      return grantJson(response, op);
    },
    async forAudience(kind, id) {
      const op = "read this audience's shares";
      const response = await get(
        grantsUrl(baseUrl, { audienceKind: kind, audienceId: id }),
        op
      );
      // An unknown audience is a real answer, so it comes back as `undefined`.
      if (response.status === 404) return undefined;
      return grantJson(response, op);
    },
    async forSubject(subjectType, subjectId) {
      const op = "read who this is shared with";
      return grantJson(
        await get(grantsUrl(baseUrl, { subjectType, subjectId }), op),
        op
      );
    },
    async create(request: GrantRequest) {
      const op = "share";
      return grantJson(await post(grantsUrl(baseUrl), op, request), op);
    },
    async revoke(grantId) {
      const op = "revoke this share";
      return grantJson(
        await post(
          new URL(vaultGrantRevokePath(encodeURIComponent(grantId)), baseUrl),
          op
        ),
        op
      );
    },
  };
}

/** The native seat's one door over the grant plane. */
export function nativeGrantDoor(baseUrl: string): GrantDoor {
  return grantDoor(nativeGrantCalls(baseUrl));
}
