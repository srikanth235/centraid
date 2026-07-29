/*
 * `/centraid/_gateway/share` — the cross-vault share plane (issue #599
 * decision 11).
 *
 * Sharing is PLACEMENT, not filtering: an item is projected out of its origin
 * vault into an audience vault (a vault IS the audience — Family,
 * Partner-only), and its bytes are hardlinked into that vault's CAS. Nobody
 * ever queries someone else's vault; what others see is only what was placed
 * where they are.
 *
 * WHY THIS IS A GATEWAY-PLANE ROUTE. Every other data route runs inside the
 * per-request `runWithVaultContext` scope (`vault-context.ts`), which names
 * exactly ONE vault. A share spans two, so it is mounted BESIDE that scope in
 * `build-gateway.ts` — after the device identity is proved, before the ambient
 * single-vault scope is entered. Both vault handles are resolved explicitly
 * here; nothing in this file reads the ambient vault.
 *
 * AUTHORIZATION introduces no new machinery (decisions 3–4). Placing an item
 * INTO a vault is a write to that vault, so it needs `write` (or `admin`) in
 * the AUDIENCE; the ORIGIN needs only the sharer's own access, so any role
 * there suffices. Both are read from `member_roles` — the acting MEMBER's
 * authority, never the device's. Host custody (L0, the landlord with shell
 * access) may do anything. Every refusal is typed and fails closed, and a
 * vault the caller holds no role in is `not_found`, never `forbidden`: a
 * refusal that distinguishes them would leak the household's vault list.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { AUTHED_DEVICE_HEADER } from "@centraid/app-engine";
import {
  isShareableItemType,
  shareToVault,
  unshareFromVault,
  VaultShareError,
} from "@centraid/vault";
import type { ShareVaultRef } from "@centraid/vault";

import type { RouteHandler } from "../serve/build-gateway.js";
import { canWrite } from "../serve/enrollment-store.js";
import type {
  EnrollmentStore,
  GrantableRole,
} from "../serve/enrollment-store.js";
import { readJson, sendJson } from "./route-helpers.js";

export const SHARE_PATH = "/centraid/_gateway/share";
const UNSHARE_PATH = `${SHARE_PATH}/remove`;

export interface ShareRouteDeps {
  enrollments: EnrollmentStore;
  /** The open vault handle for a mounted vault id, or undefined when unknown. */
  vaultFor: (vaultId: string) => ShareVaultRef | undefined;
  /** Direct host-custody request (authenticated bearer, never iroh-forwarded). */
  isHostCustody?: (req: IncomingMessage) => boolean;
}

function callerDeviceKey(req: IncomingMessage): string | undefined {
  const raw = req.headers[AUTHED_DEVICE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringField(
  body: Record<string, unknown>,
  key: string
): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * One share/unshare request's resolved subject, or the refusal to send.
 * `memberId` is undefined only on the host-custody lane, which is above the
 * role system rather than inside it.
 */
type Resolved =
  | { ok: true; memberId: string | undefined; body: Record<string, unknown> }
  | { ok: false; status: number; payload: Record<string, unknown> };

export function makeShareRouteHandler(deps: ShareRouteDeps): RouteHandler {
  /** The caller's role in a vault: host custody outranks every grant. */
  const roleIn = (
    memberId: string | undefined,
    vaultId: string
  ): GrantableRole | undefined =>
    memberId === undefined
      ? "admin"
      : deps.enrollments.members.roleIn(memberId, vaultId);

  /**
   * The audience side of every verb: the vault must be mounted AND the caller
   * must hold a write-granting role there. A vault the caller cannot see at
   * all is indistinguishable from one that does not exist.
   */
  const audienceOr = (
    memberId: string | undefined,
    audienceVaultId: string
  ):
    | { ok: true; audience: ShareVaultRef }
    | { ok: false; status: number; payload: object } => {
    const role = roleIn(memberId, audienceVaultId);
    if (role === undefined) {
      return {
        ok: false,
        status: 404,
        payload: {
          error: "not_found",
          message: `unknown vault "${audienceVaultId}"`,
        },
      };
    }
    if (!canWrite(role)) {
      return {
        ok: false,
        status: 403,
        payload: {
          error: "forbidden",
          message:
            "placing an item into a vault is a write to it, and needs write there",
        },
      };
    }
    const audience = deps.vaultFor(audienceVaultId);
    if (!audience) {
      return {
        ok: false,
        status: 404,
        payload: {
          error: "not_found",
          message: `unknown vault "${audienceVaultId}"`,
        },
      };
    }
    return { ok: true, audience };
  };

  const resolveCaller = async (req: IncomingMessage): Promise<Resolved> => {
    const hostCustody = deps.isHostCustody?.(req) === true;
    const deviceKey = callerDeviceKey(req);
    const member = deviceKey
      ? deps.enrollments.memberFor(deviceKey)
      : undefined;
    if (!member && !hostCustody) {
      return {
        ok: false,
        status: 403,
        payload: {
          error: "forbidden",
          message:
            "sharing requires a proved iroh device identity bound to a member",
        },
      };
    }
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      return { ok: false, status: 400, payload: { error: "invalid_body" } };
    }
    return { ok: true, memberId: member?.memberId, body };
  };

  return async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (url.pathname !== SHARE_PATH && url.pathname !== UNSHARE_PATH)
      return false;
    const method = req.method ?? "GET";
    const unshare = url.pathname === UNSHARE_PATH;
    if (method !== "POST" && !(unshare && method === "DELETE")) {
      return sendJson(res, 405, { error: "method_not_allowed" });
    }
    const caller = await resolveCaller(req);
    if (!caller.ok) return sendJson(res, caller.status, caller.payload);
    const { memberId, body } = caller;

    const itemType = stringField(body, "itemType");
    const itemId = stringField(body, "itemId");
    const audienceVaultId = stringField(body, "audienceVaultId");
    if (!itemId || !audienceVaultId) {
      return sendJson(res, 400, {
        error: "invalid_body",
        message: "audienceVaultId and itemId are required",
      });
    }
    if (itemType === undefined || !isShareableItemType(itemType)) {
      return sendJson(res, 400, {
        error: "invalid_item_type",
        message: `${String(itemType)} is not a shareable item type`,
      });
    }
    const resolvedAudience = audienceOr(memberId, audienceVaultId);
    if (!resolvedAudience.ok) {
      return sendJson(res, resolvedAudience.status, resolvedAudience.payload);
    }
    const { audience } = resolvedAudience;

    if (unshare) {
      const result = unshareFromVault({ audience, itemType, itemId });
      return sendJson(res, 200, result);
    }

    const originVaultId = stringField(body, "originVaultId");
    if (!originVaultId) {
      return sendJson(res, 400, {
        error: "invalid_body",
        message: "originVaultId is required",
      });
    }
    // The origin needs only the sharer's OWN access — reading their own vault
    // to place a copy elsewhere. Any authored role qualifies; none does not.
    if (roleIn(memberId, originVaultId) === undefined) {
      return sendJson(res, 404, {
        error: "not_found",
        message: `unknown vault "${originVaultId}"`,
      });
    }
    const origin = deps.vaultFor(originVaultId);
    if (!origin) {
      return sendJson(res, 404, {
        error: "not_found",
        message: `unknown vault "${originVaultId}"`,
      });
    }
    try {
      const result = shareToVault({
        origin,
        originVaultId,
        audience,
        itemType,
        itemId,
        // Host custody has no member of its own; the placement is recorded as
        // what it is rather than attributed to a person who did not act.
        sharedByMember: memberId ?? "host-custody",
      });
      return sendJson(res, 200, result);
    } catch (error) {
      if (error instanceof VaultShareError) {
        return sendJson(res, 409, {
          error: error.code,
          message: error.message,
        });
      }
      throw error;
    }
  };
}
