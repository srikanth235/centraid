import { useCallback, useEffect, useRef, useState } from "react";

import { apps as FIRST_PARTY_APPS } from "@centraid/design";

import { colorForIcon, tileVisualFromListing } from "../../app-format.js";
import { listApps, listVaults } from "../../gateway-client.js";
import { optimisticUpdate } from "./optimisticUpdate.js";
import { Store } from "./store.js";

const FIRST_PARTY_IDS: ReadonlySet<string> = new Set(
  FIRST_PARTY_APPS.map((app) => app.id)
);

async function activeVaultKey(): Promise<string | null> {
  try {
    const auth = await window.CentraidApi.getGatewayAuth();
    if (auth.vaultId) return auth.vaultId;
    const vaults = await listVaults();
    return vaults?.[0]?.vaultId ?? null;
  } catch {
    return null;
  }
}

function lastKnownVaultKey(): string | null {
  return Store.get<string | null>("home.userApps.vault", null);
}

function readInstalledCache(vault: string | null): UserAppMeta[] {
  if (vault === null) return [];
  const byVault = Store.get<Record<string, UserAppMeta[]>>(
    "home.installedApps.byVault",
    {}
  );
  const cached = byVault[vault];
  return Array.isArray(cached) ? cached : [];
}

function writeInstalledCache(vault: string | null, apps: UserAppMeta[]): void {
  if (vault === null) return;
  const byVault = Store.get<Record<string, UserAppMeta[]>>(
    "home.installedApps.byVault",
    {}
  );
  byVault[vault] = apps;
  Store.set("home.installedApps.byVault", byVault);
}

export function resetInstalledAppsCache(): void {
  Store.remove("home.installedApps.byVault");
}

export interface ShellAppsSnapshot {
  userApps: UserAppMeta[];
}

async function reconcileShellApps(): Promise<ShellAppsSnapshot | null> {
  const projs = await listApps().catch(() => null);
  if (projs === null) {
    const active = await activeVaultKey();
    const cached = readInstalledCache(active ?? lastKnownVaultKey());
    const known = lastKnownVaultKey();
    if (cached.length === 0 && (active === null || active === known))
      return null;
    return { userApps: cached };
  }
  const liveIds = new Set(projs.map((p) => p.id));
  let pins = Store.get<UserAppMeta[]>("home.userApps", []);
  const vid = await activeVaultKey();
  const pinsVault = lastKnownVaultKey();
  if (vid !== null && pinsVault !== null && pinsVault !== vid) {
    const byVault = Store.get<Record<string, UserAppMeta[]>>(
      "home.userApps.byVault",
      {}
    );
    byVault[pinsVault] = pins;
    Store.set("home.userApps.byVault", byVault);
    pins = byVault[vid] ?? [];
    Store.set("home.userApps", pins);
  }
  if (vid !== null && pinsVault !== vid) Store.set("home.userApps.vault", vid);
  const reconciled = pins
    .filter(
      (a) =>
        liveIds.has(a.id) ||
        (a.centraidAppId != null && liveIds.has(a.centraidAppId))
    )
    .map((a) => {
      const row = projs.find((p) => p.id === a.id || p.id === a.centraidAppId);
      if (!row) return a;
      const vis = tileVisualFromListing(row);
      return {
        ...a,
        ...(vis
          ? { iconKey: vis.iconKey, colorKey: vis.colorKey, color: vis.color }
          : {}),
        ...(row.name ? { name: row.name } : {}),
        ...(row.description === undefined ? {} : { desc: row.description }),
      };
    });
  if (reconciled.length !== pins.length) Store.set("home.userApps", reconciled);

  const pinnedIds = new Set(
    reconciled.flatMap((a) =>
      a.centraidAppId ? [a.id, a.centraidAppId] : [a.id]
    )
  );
  const firstParty = projs
    .filter((p) => FIRST_PARTY_IDS.has(p.id) && !pinnedIds.has(p.id))
    .map((p) => {
      const vis = tileVisualFromListing(p);
      return {
        centraidAppId: p.id,
        color: vis?.color ?? colorForIcon("Sparkle"),
        colorKey: vis?.colorKey ?? "violet",
        desc: p.description || "",
        iconKey: vis?.iconKey ?? "Sparkle",
        id: p.id,
        name: p.name || p.id,
      } as UserAppMeta;
    });
  const installed = [...reconciled, ...firstParty];
  writeInstalledCache(vid, installed);

  return { userApps: installed };
}

export interface ShellAppsController {
  userApps: UserAppMeta[];
  loading: boolean;
  refresh: () => Promise<void>;
  setUserApps: (next: UserAppMeta[]) => void;
  mutateApps: (
    apply: (snapshot: ShellAppsSnapshot) => ShellAppsSnapshot,
    commit: () => Promise<unknown>
  ) => Promise<void>;
}

export function useShellApps(): ShellAppsController {
  const [userApps, setUserApps] = useState<UserAppMeta[]>(() =>
    Store.get<UserAppMeta[]>("home.userApps", [])
  );
  const [loading, setLoading] = useState(true);

  const updateUserApps = useCallback((next: UserAppMeta[]) => {
    Store.set("home.userApps", next);
    setUserApps(next);
  }, []);

  const apply = useCallback((snapshot: ShellAppsSnapshot | null) => {
    if (snapshot === null) {
      setLoading(false);
      return;
    }
    setUserApps(snapshot.userApps);
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    apply(await reconcileShellApps());
  }, [apply]);

  useEffect(() => {
    let alive = true;
    void reconcileShellApps().then((snapshot) => {
      if (alive) apply(snapshot);
    });
    return () => {
      alive = false;
    };
  }, [apply]);

  const latest = useRef<ShellAppsSnapshot>({ userApps });
  useEffect(() => {
    latest.current = { userApps };
  });

  const mutateApps = useCallback(
    (
      edit: (snapshot: ShellAppsSnapshot) => ShellAppsSnapshot,
      commit: () => Promise<unknown>
    ) =>
      optimisticUpdate<ShellAppsSnapshot>({
        read: () => latest.current,
        write: (next) => {
          latest.current = next;
          setUserApps(next.userApps);
        },
        apply: edit,
        commit,
        settle: refresh,
      }),
    [refresh]
  );

  return {
    userApps,
    loading,
    refresh,
    setUserApps: updateUserApps,
    mutateApps,
  };
}
