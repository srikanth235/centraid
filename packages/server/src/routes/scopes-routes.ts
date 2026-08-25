/*
 * `/centraid/_vault/scopes` — the cross-vault "where may I work" plane (#599,
 * #726). It spans vaults, so it mounts BESIDE the per-request
 * `runWithVaultContext` scope: `x-centraid-vault` is ignored here.
 *
 * ORDER is registry order (default vault first, then oldest-first) and the
 * ownership filter preserves it, so a client degrading to `GET /_vault/vaults`
 * sees the same order.
 *
 * AUTHORIZATION is ownership, no roles (#726): the acting OWNER's vaults,
 * never the device's; host custody sees every mounted vault. An unowned vault
 * DOES NOT APPEAR — absence, never a "forbidden" row, so the listing cannot
 * leak the gateway's topology.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { AUTHED_DEVICE_HEADER } from "@centraid/server/engine";

import type { RouteHandler } from "../serve/build-gateway.js";
import type { EnrollmentStore } from "../serve/enrollment-store.js";
import { sendJson } from "./route-helpers.js";

export const SCOPES_PATH = "/centraid/_vault/scopes";

export interface ScopeVault {
  vaultId: string;
  name: string;
  personal?: boolean;
  color?: string;
  icon?: string;
}

export interface ScopeRow {
  vaultId: string;
  label: string;
  /** Apps derive "not my own" as `personal === false`, never from `label` (#711). */
  personal: boolean;
  color?: string;
  icon?: string;
  canWrite: boolean;
  /** Omitted entirely when the request named no app. */
  installed?: boolean;
}

export interface ScopesBody {
  scopes: ScopeRow[];
}

export interface ScopesRouteDeps {
  enrollments: EnrollmentStore;
  listVaults: () => readonly ScopeVault[];
  installedApps: (vaultId: string) => ReadonlySet<string> | undefined;
  /** Resolves false, NEVER throws, for a non-bundled id or a failed install. */
  ensureAppInstalled?: (vaultId: string, appId: string) => Promise<boolean>;
  isHostCustody?: (req: IncomingMessage) => boolean;
}

function callerDeviceKey(req: IncomingMessage): string | undefined {
  const raw = req.headers[AUTHED_DEVICE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function makeScopesRouteHandler(deps: ScopesRouteDeps): RouteHandler {
  /** Host custody sits ABOVE ownership: it answers with every mounted vault. */
  const visibleFor = (
    ownerId: string | undefined,
    vaults: readonly ScopeVault[]
  ): ScopeVault[] => {
    if (ownerId === undefined) return [...vaults];
    // An owned vault this gateway no longer carries is not a workplace.
    const owned = new Set(deps.enrollments.owners.vaultsOwnedBy(ownerId));
    return vaults.filter((vault) => owned.has(vault.vaultId));
  };

  /** Fail-soft by construction: a refused install leaves `installed: false`. */
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
      // Sourced from the visibility filter above, never derived by clients.
      canWrite: true,
      ...(installed
        ? { installed: installed.get(vault.vaultId) === true }
        : {}),
    }));

    const body: ScopesBody = { scopes: ownedScopes };
    return sendJson(res, 200, body);
  };
}
