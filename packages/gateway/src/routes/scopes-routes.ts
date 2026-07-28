/*
 * `/centraid/_vault/scopes` — the cross-vault "where may I work" plane
 * (issue #599 Phase 4).
 *
 * A member of a household holds a role in one or more vaults (`member_roles`),
 * and a client needs ONE answer to "which vaults may I switch between, and is
 * this app there?" so a scope switcher can render without N round-trips.
 *
 * WHY THIS IS A GATEWAY-PLANE ROUTE. Like the share plane (`share-routes.ts`),
 * this listing spans vaults, so it is mounted BESIDE the per-request
 * `runWithVaultContext` scope in `build-gateway.ts` — after the device identity
 * is proved, before the ambient single-vault scope is entered. The
 * `x-centraid-vault` header is irrelevant here and is deliberately ignored;
 * nothing in this file reads the ambient vault.
 *
 * ORDER is registry order — oldest vault first (ids are UUIDv7, so
 * lexicographic order IS creation order). That is the same order the composed
 * handler uses to pick a caller's default vault (`enrolled[0]`), so the
 * caller's own/primary vault — the oldest vault they hold a role in — comes
 * first among their rows without a second lookup.
 *
 * AUTHORIZATION introduces no new machinery (decisions 3–4). Authority is the
 * acting MEMBER's, never the device's. Host custody (L0, the landlord with
 * shell access) sees every mounted vault as `admin`. A vault the caller holds
 * no role in simply DOES NOT APPEAR: the listing must never leak the
 * household's vault topology, so there is no "forbidden" row, only absence.
 *
 * `installed` is reported only when the request names an app (`?app=<id>`);
 * with no app named the field is omitted entirely, because "not asked" and
 * "not installed" are different answers.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { AUTHED_DEVICE_HEADER } from "@centraid/app-engine";

import type { RouteHandler } from "../serve/build-gateway.js";
import type {
  EnrollmentStore,
  GrantableRole,
} from "../serve/enrollment-store.js";
import { sendJson } from "./route-helpers.js";

export const SCOPES_PATH = "/centraid/_vault/scopes";

/** The registry facts one scope row is rendered from (structurally `VaultInfo`). */
export interface ScopeVault {
  vaultId: string;
  name: string;
  color?: string;
  icon?: string;
}

/** One vault the caller may work in. */
export interface ScopeRow {
  vaultId: string;
  /** The vault's own name — display only, never a key. */
  label: string;
  color?: string;
  icon?: string;
  role: GrantableRole;
  /** Present only when the request named an app. */
  installed?: boolean;
}

export interface ScopesRouteDeps {
  enrollments: EnrollmentStore;
  /** Every MOUNTED vault, oldest first. */
  listVaults: () => readonly ScopeVault[];
  /** The app ids installed in one mounted vault, or undefined when unknown. */
  installedApps: (vaultId: string) => ReadonlySet<string> | undefined;
  /**
   * Auto-mount seam (see below): install + grant a BUNDLED app in an explicit
   * vault, resolving to whether it is installed there afterwards. Returns
   * false — never throws — for a non-bundled id or a failed install.
   */
  ensureAppInstalled?: (vaultId: string, appId: string) => Promise<boolean>;
  /** Direct host-custody request (authenticated bearer, never iroh-forwarded). */
  isHostCustody?: (req: IncomingMessage) => boolean;
}

function callerDeviceKey(req: IncomingMessage): string | undefined {
  const raw = req.headers[AUTHED_DEVICE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function makeScopesRouteHandler(deps: ScopesRouteDeps): RouteHandler {
  /**
   * The caller's role per vault. Host custody outranks every grant and is not
   * in `member_roles` at all, so it is answered as `admin` everywhere.
   */
  const rolesFor = (
    memberId: string | undefined,
    vaults: readonly ScopeVault[]
  ): Map<string, GrantableRole> => {
    if (memberId === undefined) {
      return new Map(
        vaults.map((vault) => [vault.vaultId, "admin" as GrantableRole])
      );
    }
    const granted = new Map(
      deps.enrollments.members
        .grants(memberId)
        .map((grant) => [grant.vaultId, grant.role])
    );
    // Intersect with what is MOUNTED: a grant on a vault this gateway no
    // longer carries is not a place the caller can work.
    return new Map(
      vaults
        .filter((vault) => granted.has(vault.vaultId))
        .map((vault) => [vault.vaultId, granted.get(vault.vaultId)!])
    );
  };

  /**
   * "The app follows the person into an audience vault they were added to."
   * When the named app is already installed in at least one of the caller's
   * OTHER vaults, install it into the ones missing it. Every role grants read,
   * so holding any role here is the read-granting condition. Fail-soft by
   * construction: a refused or failed install leaves `installed: false` for
   * that vault and never fails the listing.
   */
  const reconcileInstalls = async (
    appId: string,
    installed: Map<string, boolean>
  ): Promise<void> => {
    const ensure = deps.ensureAppInstalled;
    if (!ensure) return;
    if (![...installed.values()].some(Boolean)) return;
    const reconciled = await Promise.all(
      [...installed]
        .filter(([, present]) => !present)
        .map(async ([vaultId]) => {
          try {
            return [vaultId, await ensure(vaultId, appId)] as const;
          } catch {
            return [vaultId, false] as const;
          }
        })
    );
    for (const [vaultId, present] of reconciled)
      installed.set(vaultId, present);
  };

  return async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (url.pathname !== SCOPES_PATH) return false;
    if ((req.method ?? "GET") !== "GET") {
      return sendJson(res, 405, { error: "method_not_allowed" });
    }
    const hostCustody = deps.isHostCustody?.(req) === true;
    const deviceKey = callerDeviceKey(req);
    // Host custody is above the role system rather than inside it, so it never
    // resolves a member: it answers `admin` for every mounted vault.
    const member =
      hostCustody || deviceKey === undefined
        ? undefined
        : deps.enrollments.memberFor(deviceKey);
    if (!member && !hostCustody) {
      return sendJson(res, 403, {
        error: "forbidden",
        message:
          "listing scopes requires a proved iroh device identity bound to a member",
      });
    }

    const vaults = deps.listVaults();
    const roles = rolesFor(member?.memberId, vaults);
    const visible = vaults.filter((vault) => roles.has(vault.vaultId));

    const appId = url.searchParams.get("app") ?? undefined;
    let installed: Map<string, boolean> | undefined;
    if (appId !== undefined && appId.length > 0) {
      installed = new Map(
        visible.map((vault) => [
          vault.vaultId,
          deps.installedApps(vault.vaultId)?.has(appId) === true,
        ])
      );
      await reconcileInstalls(appId, installed);
    }

    const scopes: ScopeRow[] = visible.map((vault) => ({
      vaultId: vault.vaultId,
      label: vault.name,
      ...(vault.color === undefined ? {} : { color: vault.color }),
      ...(vault.icon === undefined ? {} : { icon: vault.icon }),
      role: roles.get(vault.vaultId)!,
      ...(installed
        ? { installed: installed.get(vault.vaultId) === true }
        : {}),
    }));
    return sendJson(res, 200, { scopes });
  };
}
