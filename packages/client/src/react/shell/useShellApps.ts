import { useCallback, useEffect, useRef, useState } from "react";

import { apps as FIRST_PARTY_APPS } from "@centraid/design";

import { colorForIcon, tileVisualFromListing } from "../../app-format.js";
import { listApps, listVaults } from "../../gateway-client.js";
import { optimisticUpdate } from "./optimisticUpdate.js";
import { Store } from "./store.js";

/**
 * The first-party app ids, resolved locally rather than fetched.
 *
 * Every one of these is installed in every vault at mount (issue #708), so a
 * listing row carrying one of these ids is an INSTALLED APP — never a draft and
 * never something waiting to be pinned.
 */
const FIRST_PARTY_IDS: ReadonlySet<string> = new Set(
  FIRST_PARTY_APPS.map((app) => app.id)
);

// Pins are per-vault state: the reconcile below prunes them against the
// active vault's listing, so pins carried across a vault switch would all
// look orphaned and be destroyed (then persisted). Resolve which vault the
// client currently addresses the same way useOwnerScopes does — the auth
// pointer, falling back to the registry's first (the gateway's default) so
// the implicit-default and explicit-id spellings of the same vault agree.
//
// `null` means UNKNOWN, and unknown is not a vault. It used to be `""`, which
// compares unequal to every real vault id — so an offline boot, where both
// reads fail, looked exactly like a switch to a vault named "": the branch
// below parked the owner's real pins under the last vault and installed
// `byVault[""] ?? []`, emptying the persisted pin list on a launch that never
// reached the gateway at all.
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

/**
 * The last vault this client knew it was addressing.
 *
 * Offline the live answer is unknown, but the installed-apps cache below is
 * keyed by vault and has to be read under SOME key. The pin store's own vault
 * pointer is that key: it was written by the last reconcile that did reach the
 * gateway, so it names the vault whose cache is on this device.
 */
function lastKnownVaultKey(): string | null {
  return Store.get<string | null>("home.userApps.vault", null);
}

/**
 * The installed set, remembered per vault, READ-ONLY.
 *
 * Distinct from the pin store on purpose. Pins are an owner's decisions and the
 * reconcile is allowed to rewrite them; this is a cache of an ANSWER the
 * gateway gave, kept solely so a launch that cannot reach the gateway still
 * paints the apps this vault has instead of the day-one empty state. Nothing
 * promotes it back into `home.userApps`, so a real uninstall of a code-store
 * app is never undone by it — the next successful reconcile simply overwrites
 * the cache with the shorter list.
 */
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

/**
 * Forget every vault's remembered installed set.
 *
 * Wired to the shell's re-scope hook (`App.tsx`, alongside `resetQueryCache`):
 * a gateway or vault change makes every cached answer describe the OLD world,
 * and a grid painted from the previous vault's cache is the same correctness
 * bug the query cache purges for.
 */
export function resetInstalledAppsCache(): void {
  Store.remove("home.installedApps.byVault");
}

/** What a reconcile pass produces; `null` means the listing itself failed.
 *  Also the unit an optimistic app mutation edits (issue #659). */
export interface ShellAppsSnapshot {
  userApps: UserAppMeta[];
  drafts: DraftAppMeta[];
}

/** The reconcile pass, shared by the mount effect and the imperative
 *  `refresh()` so neither has to call the other. Pure of React: it reads and
 *  rewrites the Store, and hands back the next lists for the caller to apply. */
async function reconcileShellApps(): Promise<ShellAppsSnapshot | null> {
  const projs = await listApps().catch(() => null);
  // The listing is the only source for what a vault HAS (issue #708), so a
  // launch with the gateway down had nothing to show and Home rendered its
  // day-one empty state on a vault holding a fully synced replica — the one
  // moment the offline copy exists for. Fall back to what the last successful
  // reconcile saw. Drafts stay empty: a draft is a builder-side row and there
  // is no honest offline answer for it.
  if (projs === null) {
    const active = await activeVaultKey();
    const cached = readInstalledCache(active ?? lastKnownVaultKey());
    // Nothing remembered for this vault. If we can NAME the vault and it is not
    // the one the lists on screen came from, an empty grid is the honest
    // answer — showing the previous vault's apps would be exactly the leak this
    // cache is keyed to avoid. Otherwise keep whatever is mounted (`null`).
    const known = lastKnownVaultKey();
    if (cached.length === 0 && (active === null || active === known))
      return null;
    return { drafts: [], userApps: cached };
  }
  const liveIds = new Set(projs.map((p) => p.id));
  // Read the current pins straight from the Store so the reconcile doesn't need
  // userApps in any dep list (avoids a stale-closure re-fetch loop).
  let pins = Store.get<UserAppMeta[]>("home.userApps", []);
  // Vault switch: park the outgoing vault's pins and pull the incoming
  // vault's set BEFORE the orphan prune below — otherwise every pin of the
  // old vault looks deleted against the new vault's listing and the prune
  // destroys them permanently (the "installed app demoted to DRAFT" bug).
  // Unknown (`null`) changes nothing: it is not a vault, so it can neither
  // trigger a park nor be recorded as the pin store's owner.
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
  // Prune orphan pins (app deleted out-of-band), then overlay tile identity
  // AND name/description — the gateway listing is the source of truth for
  // both (a rename via updateAppMeta only lands on the server; without
  // this overlay the Home tile's cached pin keeps showing the stale name
  // forever, since setUserApps() is never otherwise called after a rename).
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

  // The first-party apps, from the LISTING rather than from the pin store
  // (issue #708).
  //
  // Before this, "installed" meant "a pin the Discover install flow wrote into
  // local storage". Retiring the catalogue removed the only writer, so an app
  // the gateway had installed reached the client as an unpinned listing row —
  // which the branch below classifies as a DRAFT, and drafts are hidden
  // entirely while the builder is off. Home therefore stayed empty on a vault
  // that owned all eight apps: the pin store had become a cache of a decision
  // nothing made any more.
  //
  // Derived every pass and deliberately NOT persisted: the gateway is the
  // source of truth for what a vault has, and writing these back as pins would
  // make them survive a real uninstall of a code-store app that happened to
  // share an id.
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
  // Remember the answer for the next launch that cannot ask (see the null
  // branch at the top). Under the vault we actually resolved — never under
  // "unknown", which would file one vault's grid where any vault could read it.
  writeInstalledCache(vid, installed);

  const knownIds = new Set(installed.map((a) => a.id));
  const drafts = projs
    .filter((p) => p.kind !== "automation")
    .filter((p) => !knownIds.has(p.id))
    .map((p) => {
      const vis = tileVisualFromListing(p);
      return {
        __draft: true,
        color: vis?.color ?? colorForIcon("Sparkle"),
        colorKey: vis?.colorKey ?? "violet",
        desc: p.description || "Draft — not yet published",
        hasIndex: !!p.hasIndex,
        iconKey: vis?.iconKey ?? "Sparkle",
        id: p.id,
        name: p.name || p.id,
      } as DraftAppMeta;
    });
  return { drafts, userApps: installed };
}

export interface ShellAppsController {
  userApps: UserAppMeta[];
  drafts: DraftAppMeta[];
  /** Re-hydrate drafts + reconcile pins from the gateway listing. */
  refresh: () => Promise<void>;
  /** Replace the installed-apps list (used by CRUD paths) and persist it. */
  setUserApps: (next: UserAppMeta[]) => void;
  /**
   * Apply a local edit to both lists, run the wire call, then reconcile against
   * the gateway (issue #659). A rejection restores the pre-edit lists and
   * rethrows, so a delete or rename lands on the tile immediately and only
   * un-lands if the gateway actually refused.
   */
  mutateApps: (
    apply: (snapshot: ShellAppsSnapshot) => ShellAppsSnapshot,
    commit: () => Promise<unknown>
  ) => Promise<void>;
}

// The shell's live app state, ported from the vanilla app.ts `hydrateDrafts`
// + `persist`. `userApps` (home pins) live in the local Store; `drafts` are
// on-disk apps not yet pinned, hydrated from `listApps()`. refresh() reconciles
// pins against the gateway's source of truth (pruning orphans), overlays each
// pin's visual identity from its app.json listing (#263), then derives the
// draft list. Immutable throughout so React re-renders on change.
export function useShellApps(): ShellAppsController {
  const [userApps, setUserApps] = useState<UserAppMeta[]>(() =>
    Store.get<UserAppMeta[]>("home.userApps", [])
  );
  const [drafts, setDrafts] = useState<DraftAppMeta[]>([]);

  const updateUserApps = useCallback((next: UserAppMeta[]) => {
    Store.set("home.userApps", next);
    setUserApps(next);
  }, []);

  const apply = useCallback((snapshot: ShellAppsSnapshot | null) => {
    if (snapshot === null) {
      setDrafts([]);
      return;
    }
    setUserApps(snapshot.userApps);
    setDrafts(snapshot.drafts);
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

  // Read through refs so the mutation does not have to re-create itself (and
  // re-render every consumer) each time the lists change.
  const latest = useRef<ShellAppsSnapshot>({ userApps, drafts });
  useEffect(() => {
    latest.current = { userApps, drafts };
  });

  const mutateApps = useCallback(
    (
      edit: (snapshot: ShellAppsSnapshot) => ShellAppsSnapshot,
      commit: () => Promise<unknown>
    ) =>
      optimisticUpdate<ShellAppsSnapshot>({
        read: () => latest.current,
        // The guess is NOT persisted to the Store — `refresh` reconciles
        // against the gateway and that reconcile owns what gets written.
        write: (next) => {
          latest.current = next;
          setUserApps(next.userApps);
          setDrafts(next.drafts);
        },
        apply: edit,
        commit,
        settle: refresh,
      }),
    [refresh]
  );

  return {
    userApps,
    drafts,
    refresh,
    setUserApps: updateUserApps,
    mutateApps,
  };
}
