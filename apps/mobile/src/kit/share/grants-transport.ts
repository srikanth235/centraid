import { grantDoor } from "@centraid/blueprints/apps/_shared/grant-door";
import type {
  GrantDoor,
  GrantWireCalls,
} from "@centraid/blueprints/apps/_shared/grant-door";
import type { GrantRequest } from "@centraid/blueprints/apps/_shared/grant-plane";
// The NATIVE seat's transport into the grant plane (issue #825) —
// `packages/server/src/routes/grant-routes.ts`, reached the same way
// `lib/replica/links-transport.ts` reaches `/links`.
//
// This module is the whole of the seat difference. Native holds an authed base
// URL and can call the gateway directly, where the web blueprint kit must go
// through the shell's bridge; everything downstream of that — parsing, the
// refusal contract, what "already shared" means, what a revoke says — is
// `@centraid/blueprints/apps/_shared/grant-door`, shared with the web seat, so
// the two seats cannot drift into two readings of one answer.
//
// Paths come from `@centraid/core/protocol`; no literal lives here.
import { ROUTES, vaultGrantRevokePath } from "@centraid/core/protocol";

import { apiHeaders } from "../../lib/gateway";

/**
 * One grant-plane answer. A refused call rejects with the route's OWN message
 * so the sheet prints it verbatim — `subject_not_offerable` names the
 * capabilities that subject does answer, and no local paraphrase can.
 */
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

/** The native seat's calls, in the shape `grantDoor` takes. */
export function nativeGrantCalls(baseUrl: string): GrantWireCalls {
  const get = (url: URL | string): Promise<Response> =>
    fetch(url, { headers: apiHeaders() });
  const post = (url: URL | string, payload?: unknown): Promise<Response> =>
    fetch(url, {
      method: "POST",
      headers: apiHeaders(
        payload === undefined ? {} : { "content-type": "application/json" }
      ),
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
  return {
    async subjects() {
      const op = "read shareable subjects";
      return grantJson(
        await get(new URL(ROUTES.vaultGrantSubjects, baseUrl)),
        op
      );
    },
    async forParty(partyId) {
      const op = "read what this person can reach";
      const response = await get(grantsUrl(baseUrl, { partyId }));
      // `audience_not_found` is a real answer — this vault knows no such
      // person — and letting it throw would make it arrive wearing "shares
      // could not be read", which is a different sentence entirely.
      if (response.status === 404) return undefined;
      return grantJson(response, op);
    },
    async forAudience(kind, id) {
      const op = "read this audience's shares";
      const response = await get(
        grantsUrl(baseUrl, { audienceKind: kind, audienceId: id })
      );
      // An audience the vault has no record of is a real answer, distinct from
      // an audience with nothing shared — so it comes back as `undefined`
      // rather than as a thrown transport failure.
      if (response.status === 404) return undefined;
      return grantJson(response, op);
    },
    async forSubject(subjectType, subjectId) {
      const op = "read who this is shared with";
      return grantJson(
        await get(grantsUrl(baseUrl, { subjectType, subjectId })),
        op
      );
    },
    async create(request: GrantRequest) {
      const op = "share";
      return grantJson(await post(grantsUrl(baseUrl), request), op);
    },
    async revoke(grantId) {
      const op = "revoke this share";
      return grantJson(
        await post(
          new URL(vaultGrantRevokePath(encodeURIComponent(grantId)), baseUrl)
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
