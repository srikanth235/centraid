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
  personal: boolean;
  color?: string;
  icon?: string;
  canWrite: boolean;
  installed?: boolean;
}

export interface ScopesBody {
  scopes: ScopeRow[];
}

export interface ScopesRouteDeps {
  enrollments: EnrollmentStore;
  listVaults: () => readonly ScopeVault[];
  installedApps: (vaultId: string) => ReadonlySet<string> | undefined;
  ensureAppInstalled?: (vaultId: string, appId: string) => Promise<boolean>;
  isHostCustody?: (req: IncomingMessage) => boolean;
}

function callerDeviceKey(req: IncomingMessage): string | undefined {
  const raw = req.headers[AUTHED_DEVICE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function makeScopesRouteHandler(deps: ScopesRouteDeps): RouteHandler {
  const visibleFor = (
    ownerId: string | undefined,
    vaults: readonly ScopeVault[]
  ): ScopeVault[] => {
    if (ownerId === undefined) return [...vaults];
    const owned = new Set(deps.enrollments.owners.vaultsOwnedBy(ownerId));
    return vaults.filter((vault) => owned.has(vault.vaultId));
  };

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
      canWrite: true,
      ...(installed
        ? { installed: installed.get(vault.vaultId) === true }
        : {}),
    }));

    const body: ScopesBody = { scopes: ownedScopes };
    return sendJson(res, 200, body);
  };
}
