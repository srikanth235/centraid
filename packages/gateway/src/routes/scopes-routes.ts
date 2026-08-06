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
 * ORDER is registry order (`VaultRegistry.list()`): the gateway's DEFAULT
 * vault — the owner's personal one, by the durable `personal` marker — first,
 * then the remainder oldest-first (ids are UUIDv7, so lexicographic order IS
 * creation order). Issue #665: before that hoist the head was simply the
 * oldest vault, which on an auto-founded gateway is `Shared`, so a client
 * taking `scopes[0]` as PRIMARY disagreed with the gateway's own
 * `defaultVaultId()`. Filtering to the caller's roles preserves the order, so
 * the caller's primary vault comes first among their rows without a second
 * lookup. `GET /_vault/vaults` reads the same registry listing, so a client
 * that degrades to it sees the identical order.
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
 *
 * THE AUDIENCE RIDES ALONG PER SCOPE (issue #712, P7) — everyone who holds a
 * role in that vault, name and role, from `MemberStore.membersOf`. Safe to
 * attach unconditionally because a scope only appears in `visible` when the
 * CALLER already holds a role there: nothing here can tell a caller about a
 * vault they cannot already see, and knowing who ELSE can see it is not a new
 * fact beyond that — every member of a household vault already sees each
 * other on Household settings' own roster.
 *
 * THE SHARE DESTINATION RIDES ALONG (issue #711 item H) as
 * `defaultShareTargetVaultId`, beside the rows rather than on one of them: a
 * member may want to share into several vaults, so "where my shares go" is a
 * pointer they own (`share-target.ts`), never a property of a vault record.
 * The rows themselves carry only `personal` — the founding marker — and every
 * "somewhere other than my own" marker is exactly `personal === false`.
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
  /** The durable founding marker (`core_vault.settings_json.personal`). */
  personal?: boolean;
  color?: string;
  icon?: string;
}

/** One person who can see a vault, and the role they hold there — the P7
 *  grant roster (issue #712). */
export interface AudienceMember {
  memberId: string;
  name: string;
  role: GrantableRole;
}

/** One vault the caller may work in. */
export interface ScopeRow {
  vaultId: string;
  /** The vault's own name — display only, never a key. */
  label: string;
  /**
   * Whether this is the member's OWN vault — the durable founding marker
   * (issue #711 item H). Always present, so an app can derive its "somewhere
   * other than my own" marker as exactly `personal === false` and never from
   * `label`, which the owner is free to rename. There is no second marker
   * and no vault "kind": sharing is a destination somebody chose (see
   * `defaultShareTargetVaultId`), never a property of a vault record.
   */
  personal: boolean;
  color?: string;
  icon?: string;
  role: GrantableRole;
  /** Present only when the request named an app. */
  installed?: boolean;
  /** Everyone who holds a role here — present only when `deps.membersOf` is
   *  wired (issue #712, P7). Absent, not `[]`, on a host that answers no
   *  roster at all, so a caller can tell "no audience beyond me" from "this
   *  gateway does not answer that question". */
  audience?: readonly AudienceMember[];
}

/** The whole answer: the caller's scopes, and where their shares go. */
export interface ScopesBody {
  scopes: ScopeRow[];
  /**
   * The vault this member's shares land in by default (issue #711 item H) —
   * a POINTER they own, not a property of any vault. Reported AS STORED: it
   * may name a vault that is not in `scopes` (deleted, or one this member
   * holds no role in), and a client renders that as the action disabled with
   * the reason inline rather than silently doing nothing. Absent when nothing
   * has ever been pointed at.
   */
  defaultShareTargetVaultId?: string;
}

export interface ScopesRouteDeps {
  enrollments: EnrollmentStore;
  /** Every MOUNTED vault in registry listing order — default vault first. */
  listVaults: () => readonly ScopeVault[];
  /** This member's default share destination — see `ScopesBody`. */
  defaultShareTarget?: (memberId: string | undefined) => string | undefined;
  /** Everyone holding a role in one vault — see `ScopeRow.audience` (issue
   *  #712, P7). Omitted entirely (not merely returning `[]`) means the row
   *  carries no `audience` field at all. */
  membersOf?: (vaultId: string) => readonly AudienceMember[];
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
      personal: vault.personal === true,
      ...(vault.color === undefined ? {} : { color: vault.color }),
      ...(vault.icon === undefined ? {} : { icon: vault.icon }),
      role: roles.get(vault.vaultId)!,
      ...(installed
        ? { installed: installed.get(vault.vaultId) === true }
        : {}),
      ...(deps.membersOf ? { audience: deps.membersOf(vault.vaultId) } : {}),
    }));
    const shareTarget = deps.defaultShareTarget?.(member?.memberId);
    const body: ScopesBody = {
      scopes,
      ...(shareTarget === undefined
        ? {}
        : { defaultShareTargetVaultId: shareTarget }),
    };
    return sendJson(res, 200, body);
  };
}
