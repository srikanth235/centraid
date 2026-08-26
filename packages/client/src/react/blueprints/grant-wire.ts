// Shell transport for the GRANT PLANE (#825) — server grant-routes.ts; kits
// never see URLs. Bodies answer as `unknown`: parsing/refusal law lives once
// in grant-door.
import { ROUTES, vaultGrantRevokePath } from "@centraid/core/protocol";

import { authHeaders, doFetch } from "../../gateway-client-core.js";
import type { GatewayAuth } from "../../gateway-client-core.js";

/** Exactly what `POST …/grants` takes. */
export interface GrantCreateRequest {
  audienceKind: "party" | "circle";
  audienceId: string;
  subjectType: string;
  subjectId: string;
  capability: "view" | "edit";
  subjectLabel?: string;
}

/** The bridge `window.centraid.grants` exposes. */
export interface GrantBridge {
  subjects: () => Promise<unknown>;
  /** `undefined` = unknown person (404). */
  forParty: (partyId: string) => Promise<unknown | undefined>;
  /** `undefined` = unknown audience (404). */
  forAudience: (
    kind: "party" | "circle",
    id: string
  ) => Promise<unknown | undefined>;
  forSubject: (subjectType: string, subjectId: string) => Promise<unknown>;
  create: (request: GrantCreateRequest) => Promise<unknown>;
  revoke: (grantId: string) => Promise<unknown>;
}

/** Refusals reject with route `message`; non-JSON bodies with status. */
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
      // 404 is an answer, not a read failure.
      if (response.status === 404) return undefined;
      return grantJson(response, op);
    },
    async forAudience(kind, id) {
      const op = "read this audience's shares";
      const response = await get(query({ audienceKind: kind, audienceId: id }));
      // Unknown audience is a drawable `undefined`, not a failure.
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
