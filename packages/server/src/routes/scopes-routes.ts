/*
 * `/centraid/_vault/scopes` — the cross-vault "where may I work" plane
 * (issue #599 Phase 4; ownership since #726).
 *
 * An owner owns one or more vaults (`vault_owners`), and a client needs ONE
 * answer to "which vaults may I switch between, and is this app there?" so a
 * scope switcher can render without N round-trips.
 *
 * WHY THIS IS A GATEWAY-PLANE ROUTE. This listing spans vaults, so it is
 * mounted BESIDE the per-request `runWithVaultContext` scope in
 * `build-gateway.ts` — after the device identity is proved, before the
 * ambient single-vault scope is entered. The `x-centraid-vault` header is
 * irrelevant here and is deliberately ignored; nothing in this file reads
 * the ambient vault.
 *
 * ORDER is registry order (`VaultRegistry.list()`): the gateway's DEFAULT
 * vault — the owner's personal one, by the durable `personal` marker — first,
 * then the remainder oldest-first (ids are UUIDv7, so lexicographic order IS
 * creation order). Filtering to the caller's owned vaults preserves the
 * order, so the caller's primary vault comes first among their rows without
 * a second lookup. `GET /_vault/vaults` reads the same registry listing, so
 * a client that degrades to it sees the identical order.
 *
 * AUTHORIZATION is ownership, no roles (#726): the acting OWNER's vaults,
 * never the device's. Host custody (L0, the landlord with shell access) sees
 * every mounted vault. A vault the caller does not own simply DOES NOT
 * APPEAR: the listing must never leak the gateway's vault topology, so there
 * is no "forbidden" row, only absence.
 *
 * `canWrite` keeps its exact client/blueprint shape with a new source: a
 * vault you own is writable. It stays a per-row wire field — not a constant
 * clients derive — because capability remains an explicit contract field.
 *
 * `installed` is reported only when the request names an app (`?app=<id>`);
 * with no app named the field is omitted entirely, because "not asked" and
 * "not installed" are different answers.
 *
 * Commons rows are ordinary rows in each member's own vault. They therefore
 * need no synthetic scope or special mount policy here.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { AUTHED_DEVICE_HEADER } from "@centraid/server/engine";

import type { RouteHandler } from "../serve/build-gateway.js";
import type { EnrollmentStore } from "../serve/enrollment-store.js";
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

/** One vault the caller may work in. */
export interface ScopeRow {
  vaultId: string;
  /** The vault's own name — display only, never a key. */
  label: string;
  /**
   * Whether this is the owner's OWN vault — the durable founding marker
   * (issue #711 item H). Always present, so an app can derive its "somewhere
   * other than my own" marker as exactly `personal === false` and never from
   * `label`, which the owner is free to rename.
   */
  personal: boolean;
  color?: string;
  icon?: string;
  /** Ownership-sourced writability: a vault you own is writable. */
  canWrite: boolean;
  /** Present only when the request named an app. */
  installed?: boolean;
}

/** The whole answer: the caller's scopes. */
export interface ScopesBody {
  scopes: ScopeRow[];
}

export interface ScopesRouteDeps {
  enrollments: EnrollmentStore;
  /** Every MOUNTED vault in registry listing order — default vault first. */
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
   * The caller's reachable vaults. Host custody is above ownership rather
   * than inside it, so it is answered with every mounted vault.
   */
  const visibleFor = (
    ownerId: string | undefined,
    vaults: readonly ScopeVault[]
  ): ScopeVault[] => {
    if (ownerId === undefined) return [...vaults];
    // Intersect with what is MOUNTED: an owned vault this gateway no longer
    // carries is not a place the caller can work.
    const owned = new Set(deps.enrollments.owners.vaultsOwnedBy(ownerId));
    return vaults.filter((vault) => owned.has(vault.vaultId));
  };

  /**
   * "The app follows the person into a vault they own."
   * When the named app is already installed in at least one of the caller's
   * OTHER vaults, install it into the ones missing it. Fail-soft by
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
    // Host custody never resolves an owner: it sees every mounted vault.
    const owner =
      hostCustody || deviceKey === undefined
        ? undefined
        : deps.enrollments.ownerFor(deviceKey);
    if (!owner && !hostCustody) {
      return sendJson(res, 403, {
        error: "forbidden",
        message:
          "listing scopes requires a proved iroh device identity bound to an owner",
      });
    }

    const vaults = deps.listVaults();
    const visible = visibleFor(owner?.ownerId, vaults);

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

    const ownedScopes: ScopeRow[] = visible.map((vault) => ({
      vaultId: vault.vaultId,
      label: vault.name,
      personal: vault.personal === true,
      ...(vault.color === undefined ? {} : { color: vault.color }),
      ...(vault.icon === undefined ? {} : { icon: vault.icon }),
      // Every row here is owned by the caller (or host custody), so it is
      // writable — sourced from the visibility filter above, never derived
      // by clients.
      canWrite: true,
      ...(installed
        ? { installed: installed.get(vault.vaultId) === true }
        : {}),
    }));

    const body: ScopesBody = { scopes: ownedScopes };
    return sendJson(res, 200, body);
  };
}
