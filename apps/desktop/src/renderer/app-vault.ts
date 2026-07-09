// The per-app Vault tab (duaility §12) — the owner consent surface for one
// app, rendered inside the app-settings popover. Three jobs:
//
//   1. show WHAT the app asked for — the manifest-declared `vault` block
//      (purpose, why, scopes), which is a *request*, never access;
//   2. let the owner grant exactly that request (deny-by-default until the
//      grant lands) or revoke it (the cascade runs gateway-side);
//   3. surface this app's parked invocations — confirm-gated (Tier 3/4,
//      issue #306) commands wait here for the owner's explicit say-so.
//
// The tab only appears for apps whose manifest declares a `vault` block
// (see `app-appview.ts`). Everything here talks to `/centraid/_vault/*`
// through `gateway-client-vault.ts`; the React VaultScreen owns the view
// (including the "no vault mounted" state) — this module supplies the
// gateway I/O it renders.
import {
  approveVaultGrant,
  confirmVaultParked,
  revokeVaultGrant,
  vaultApps,
  vaultDemoLoad,
  vaultDemoPurge,
  vaultDemoStatus,
  vaultParked,
  vaultStatus,
  type VaultDemoApp,
  type VaultScope,
} from './gateway-client.js';
import { requireReactBridge } from './react/bridge.js';

/** The manifest-declared access request (`app.json#vault`). */
export interface ManifestVaultBlock {
  purpose: string;
  why: string;
  scopes: VaultScope[];
}

/** Parse the `vault` block out of a fetched `app.json`, if sound. */
export function manifestVaultBlock(manifest: unknown): ManifestVaultBlock | null {
  if (!manifest || typeof manifest !== 'object') return null;
  const vault = (manifest as { vault?: unknown }).vault;
  if (!vault || typeof vault !== 'object') return null;
  const v = vault as Record<string, unknown>;
  if (typeof v.purpose !== 'string' || !Array.isArray(v.scopes)) return null;
  return {
    purpose: v.purpose,
    why: typeof v.why === 'string' ? v.why : '',
    scopes: v.scopes as VaultScope[],
  };
}

export interface VaultPaneInput {
  el: ElHelper;
  appId: string;
  block: ManifestVaultBlock;
  host: HTMLElement;
  /** Fired after a grant / revoke / confirmation so the app view can reload. */
  onAccessChanged?: () => void;
  /** Reports the parked count so the tab badge can show it. */
  onParkedCount?: (count: number) => void;
  showToast?: (message: string) => void;
}

// Tracks the React root mounted on a given host so re-opening the tab onto the
// same node disposes the previous root before mounting a fresh one.
const reactDisposers = new WeakMap<HTMLElement, () => void>();

/**
 * Populate the Vault pane. gateway I/O stays here (loadData + the action
 * thunks); the React VaultScreen owns the view, its own loading/error/empty
 * states, and reloads itself after each owner act.
 */
export async function renderVaultPane(input: VaultPaneInput): Promise<void> {
  const { appId, block, host } = input;
  reactDisposers.get(host)?.();
  const dispose = requireReactBridge().mountVault(host, {
    block,
    confirm: (invocationId, approve) =>
      confirmVaultParked({ approve, invocationId }).then(() => undefined),
    demoLoad: () => vaultDemoLoad(appId).then(() => undefined),
    demoPurge: () => vaultDemoPurge(appId).then(() => undefined),
    grant: () =>
      approveVaultGrant({ appId, purpose: block.purpose, scopes: block.scopes }).then(
        () => undefined,
      ),
    loadData: async () => {
      const s = await vaultStatus().catch(() => undefined);
      if (!s) return null;
      const [apps, allParked, demoApps] = await Promise.all([
        vaultApps(),
        vaultParked(),
        vaultDemoStatus().catch(() => [] as VaultDemoApp[]),
      ]);
      return {
        demo: demoApps.find((d) => d.appId === appId),
        grants: apps.find((a) => a.name === appId)?.grants ?? [],
        parked: allParked.filter((p) => p.callerKind === 'app' && p.caller === appId),
        vaultName: s.name,
      };
    },
    onAccessChanged: input.onAccessChanged,
    onParkedCount: input.onParkedCount,
    revoke: (grantId) => revokeVaultGrant({ grantId }).then(() => undefined),
    showToast: input.showToast,
  });
  reactDisposers.set(host, dispose);
}
