// The shell's transport for the GRANT PLANE (issue #825) —
// `packages/server/src/routes/grant-routes.ts`, reached the same way
// `share-wire.ts` reaches the commons routes.
//
// Every path comes from `@centraid/core/protocol`; a blueprint kit never sees
// a URL. The bridge answers the route's parsed JSON body as `unknown` on
// purpose: the parsing and refusal law lives once in
// `@centraid/blueprints/apps/_shared/grant-door`, shared with the native seat,
// so the shell must not pre-digest a payload into a second reading of it.
//
// Refusals carry the ROUTE'S OWN message. `subject_not_offerable` names the
// capabilities that subject does answer, and the revoke sentence is derived
// from what each delivered copy actually did — a generic transport error in
// front of either would throw the honest half away.
import { ROUTES, vaultGrantRevokePath } from "@centraid/core/protocol";

import { authHeaders, doFetch } from "../../gateway-client-core.js";
import type { GatewayAuth } from "../../gateway-client-core.js";

/** One create request, exactly as `POST …/grants` takes it. */
export interface GrantCreateRequest {
  audienceKind: "party" | "circle";
  audienceId: string;
  subjectType: string;
  subjectId: string;
  capability: "view" | "edit";
  subjectLabel?: string;
}

/** The bridge `window.centraid.grants` exposes to an inline blueprint app. */
export interface GrantBridge {
  subjects: () => Promise<unknown>;
  /** `undefined` for a person this vault has no record of (404). */
  forParty: (partyId: string) => Promise<unknown | undefined>;
  /** `undefined` for an audience this vault has no record of (404). */
  forAudience: (
    kind: "party" | "circle",
    id: string
  ) => Promise<unknown | undefined>;
  forSubject: (subjectType: string, subjectId: string) => Promise<unknown>;
  create: (request: GrantCreateRequest) => Promise<unknown>;
  revoke: (grantId: string) => Promise<unknown>;
}

/**
 * Read one grant-plane answer. A refused call rejects with the route's own
 * `message` so the sheet can print it verbatim; a body that is not JSON at all
 * rejects with the status, because there is nothing honest to quote.
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
  const message = (parsed as { message?: unknown; error?: unknown }).message;
  if (typeof message === "string" && message.length) throw new Error(message);
  const error = (parsed as { error?: unknown }).error;
  throw new Error(
    typeof error === "string" && error.length
      ? `${op}: ${error}`
      : `${op} failed (${response.status})`
  );
}

function query(params: Record<string, string>): string {
  return `${ROUTES.vaultGrants}?${new URLSearchParams(params).toString()}`;
}

export function grantBridge(auth: () => Promise<GatewayAuth>): GrantBridge {
  const get = async (pathname: string): Promise<Response> => {
    const gatewayAuth = await auth();
    return doFetch(gatewayAuth.baseUrl, pathname, {
      headers: authHeaders(gatewayAuth.token),
    });
  };
  const post = async (
    pathname: string,
    payload?: unknown
  ): Promise<Response> => {
    const gatewayAuth = await auth();
    return doFetch(gatewayAuth.baseUrl, pathname, {
      method: "POST",
      headers: authHeaders(gatewayAuth.token, "application/json"),
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
  };
  return {
    async subjects() {
      return grantJson(
        await get(ROUTES.vaultGrantSubjects),
        "read shareable subjects"
      );
    },
    async forParty(partyId) {
      const op = "read what this person can reach";
      const response = await get(query({ partyId }));
      // `audience_not_found` is a real answer — this vault knows no such
      // person — and letting it throw would make it arrive wearing "shares
      // could not be read", which is a different sentence entirely.
      if (response.status === 404) return undefined;
      return grantJson(response, op);
    },
    async forAudience(kind, id) {
      const op = "read this audience's shares";
      const response = await get(query({ audienceKind: kind, audienceId: id }));
      // An audience the vault has no record of is a real, drawable answer —
      // not the same as an audience with nothing shared — so it comes back as
      // `undefined` rather than as a thrown transport failure.
      if (response.status === 404) return undefined;
      return grantJson(response, op);
    },
    async forSubject(subjectType, subjectId) {
      const op = "read who this is shared with";
      return grantJson(await get(query({ subjectType, subjectId })), op);
    },
    async create(request) {
      const op = "share";
      return grantJson(await post(ROUTES.vaultGrants, request), op);
    },
    async revoke(grantId) {
      const op = "revoke this share";
      return grantJson(
        await post(vaultGrantRevokePath(encodeURIComponent(grantId))),
        op
      );
    },
  };
}
