import { Store } from './store.js';
import { useCallback, useEffect, useState } from 'react';
import { colorForIcon, tileVisualFromListing } from '../../app-format.js';
import { listApps, listVaults } from '../../gateway-client.js';

// Pins are per-vault state: the reconcile below prunes them against the
// active vault's listing, so pins carried across a vault switch would all
// look orphaned and be destroyed (then persisted). Resolve which vault the
// client currently addresses the same way useActiveVault does — the auth
// pointer, falling back to the registry's first (the gateway's default) so
// the implicit-default and explicit-id spellings of the same vault agree.
async function activeVaultKey(): Promise<string> {
  try {
    const auth = await window.CentraidApi.getGatewayAuth();
    if (auth.vaultId) return auth.vaultId;
    const vaults = await listVaults();
    return vaults?.[0]?.vaultId ?? '';
  } catch {
    return '';
  }
}

export interface ShellAppsController {
  userApps: UserAppMeta[];
  drafts: DraftAppMeta[];
  /** Re-hydrate drafts + reconcile pins from the gateway listing. */
  refresh: () => Promise<void>;
  /** Replace the installed-apps list (used by CRUD paths) and persist it. */
  setUserApps: (next: UserAppMeta[]) => void;
}

// The shell's live app state, ported from the vanilla app.ts `hydrateDrafts`
// + `persist`. `userApps` (home pins) live in the local Store; `drafts` are
// on-disk apps not yet pinned, hydrated from `listApps()`. refresh() reconciles
// pins against the gateway's source of truth (pruning orphans), overlays each
// pin's visual identity from its app.json listing (#263), then derives the
// draft list. Immutable throughout so React re-renders on change.
export function useShellApps(): ShellAppsController {
  const [userApps, setUserAppsState] = useState<UserAppMeta[]>(() =>
    Store.get<UserAppMeta[]>('home.userApps', []),
  );
  const [drafts, setDrafts] = useState<DraftAppMeta[]>([]);

  const setUserApps = useCallback((next: UserAppMeta[]) => {
    Store.set('home.userApps', next);
    setUserAppsState(next);
  }, []);

  const refresh = useCallback(async () => {
    let projs: Awaited<ReturnType<typeof listApps>>;
    try {
      projs = await listApps();
    } catch {
      setDrafts([]);
      return;
    }
    const liveIds = new Set(projs.map((p) => p.id));
    // Read the current pins straight from the Store so refresh() doesn't need
    // userApps in its dep list (avoids a stale-closure re-fetch loop).
    let pins = Store.get<UserAppMeta[]>('home.userApps', []);
    // Vault switch: park the outgoing vault's pins and pull the incoming
    // vault's set BEFORE the orphan prune below — otherwise every pin of the
    // old vault looks deleted against the new vault's listing and the prune
    // destroys them permanently (the "installed app demoted to DRAFT" bug).
    const vid = await activeVaultKey();
    const pinsVault = Store.get<string | null>('home.userApps.vault', null);
    if (pinsVault !== null && pinsVault !== vid) {
      const byVault = Store.get<Record<string, UserAppMeta[]>>('home.userApps.byVault', {});
      byVault[pinsVault] = pins;
      Store.set('home.userApps.byVault', byVault);
      pins = byVault[vid] ?? [];
      Store.set('home.userApps', pins);
    }
    if (pinsVault !== vid) Store.set('home.userApps.vault', vid);
    // Prune orphan pins (app deleted out-of-band), then overlay tile identity
    // AND name/description — the gateway listing is the source of truth for
    // both (a rename via updateAppMeta only lands on the server; without
    // this overlay the Home tile's cached pin keeps showing the stale name
    // forever, since setUserApps() is never otherwise called after a rename).
    const reconciled = pins
      .filter((a) => liveIds.has(a.id) || (a.centraidAppId != null && liveIds.has(a.centraidAppId)))
      .map((a) => {
        const row = projs.find((p) => p.id === a.id || p.id === a.centraidAppId);
        if (!row) return a;
        const vis = tileVisualFromListing(row);
        return {
          ...a,
          ...(vis ? { iconKey: vis.iconKey, colorKey: vis.colorKey, color: vis.color } : {}),
          ...(row.name ? { name: row.name } : {}),
          ...(row.description !== undefined ? { desc: row.description } : {}),
        };
      });
    if (reconciled.length !== pins.length) Store.set('home.userApps', reconciled);
    setUserAppsState(reconciled);

    const knownIds = new Set(reconciled.map((a) => a.id));
    setDrafts(
      projs
        .filter((p) => p.kind !== 'automation')
        .filter((p) => !knownIds.has(p.id))
        .map((p) => {
          const vis = tileVisualFromListing(p);
          return {
            __draft: true,
            color: vis?.color ?? colorForIcon('Sparkle'),
            colorKey: vis?.colorKey ?? 'violet',
            desc: p.description || 'Draft — not yet published',
            hasIndex: !!p.hasIndex,
            iconKey: vis?.iconKey ?? 'Sparkle',
            id: p.id,
            name: p.name || p.id,
          } as DraftAppMeta;
        }),
    );
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { userApps, drafts, refresh, setUserApps };
}
