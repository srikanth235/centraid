import {
  appLiveUrl,
  appSettings,
  appSettingWrite,
  approveVaultGrant,
  confirmVaultParked,
  readAutomationRun,
  revokeVaultGrant,
  vaultApps,
  vaultDemoLoad,
  vaultDemoPurge,
  vaultDemoStatus,
  vaultParked,
  vaultStatus,
  type VaultDemoApp,
  type VaultScope,
} from '../../../gateway-client.js';
import type { VaultBlockDTO, VaultBridgeProps } from '../../screen-contracts.js';

// The gateway I/O + manifest parsing behind the React app-settings popover —
// the successor to the helpers that lived in the deleted app-appview.ts /
// app-vault.ts. Pure/injected so AppSettingsController can stay declarative.

/** One manifest-declared appearance knob (`app.json#knobs[]`). */
export interface AppKnob {
  key: string;
  label: string;
  type: 'segmented' | 'swatch';
  default: string;
  options: { value: string; label: string }[];
}

export interface AppKnobsManifest {
  version: number;
  knobs: AppKnob[];
}

/** Fetch the app's own `app.json` (next to its index.html), or null. */
export async function fetchAppManifestRaw(appId: string): Promise<Record<string, unknown> | null> {
  try {
    const live = await appLiveUrl({ id: appId });
    const url = `${live.url.replace(/\/?$/, '/')}app.json`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const parsed = (await res.json()) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Parse the appearance-knobs array out of a fetched manifest. */
export function knobsManifestFrom(raw: Record<string, unknown> | null): AppKnobsManifest | null {
  if (!raw || !Array.isArray(raw.knobs)) return null;
  const version = typeof raw.manifestVersion === 'number' ? raw.manifestVersion : 1;
  return { version, knobs: raw.knobs as AppKnob[] };
}

/** Parse the manifest `vault` request block, if declared + sound. */
export function manifestVaultBlock(raw: Record<string, unknown> | null): VaultBlockDTO | null {
  if (!raw || typeof raw !== 'object') return null;
  const vault = (raw as { vault?: unknown }).vault;
  if (!vault || typeof vault !== 'object') return null;
  const v = vault as Record<string, unknown>;
  if (typeof v.purpose !== 'string' || !Array.isArray(v.scopes)) return null;
  return {
    purpose: v.purpose,
    why: typeof v.why === 'string' ? v.why : '',
    scopes: v.scopes as VaultScope[],
  };
}

/** Read the app's stored knob values from its settings.json (strings only). */
export async function fetchAppKnobValues(appId: string): Promise<Record<string, string>> {
  try {
    const settings = await appSettings({ id: appId });
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(settings)) {
      if (typeof value === 'string' && !key.startsWith('__')) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** Persist one knob value (the runtime kebab-cases at bake time). */
export async function writeAppKnobValue(appId: string, key: string, value: string): Promise<void> {
  await appSettingWrite({ id: appId, key, value });
}

// Settings key (camelCase, e.g. `appFont`) → the kebab name shared by the
// data-attr and CSS-var paths. Mirrors camelTailToKebab in app-engine's
// settings-merge so a live edit lands on the same target a reload will bake.
function appKnobKebab(key: string): string {
  const tail = key.startsWith('app') ? key.slice(3) : key;
  return `app-${tail.charAt(0).toLowerCase()}${tail.slice(1).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** The single visible sandboxed app iframe (only one app-view is mounted). */
function appFrame(): HTMLIFrameElement | null {
  return document.querySelector<HTMLIFrameElement>('iframe[data-centraid-app]');
}

/** Live-push a knob to the running app frame (no reload). */
export function pushKnobToAppFrame(key: string, value: string): void {
  const frame = appFrame();
  if (!frame) return;
  const name = appKnobKebab(key);
  // Keys ending Color/Accent are continuous colour values → CSS vars; the rest
  // are discrete states → data attributes. Keeps live edit + reload identical.
  const isCss = /(?:Color|Accent)$/.test(key);
  const dataAttrs = isCss ? {} : { [name]: value };
  const cssVars = isCss ? { [name]: value } : {};
  frame.contentWindow?.postMessage({ type: 'centraid:settings', dataAttrs, cssVars }, '*');
}

/**
 * Live-push a knob to an INLINE app's root element (issue #505). Same
 * kebab/CSS-var-vs-data-attr split as `pushKnobToAppFrame`, but applied straight
 * to the element the inline app reads (no iframe, no postMessage). The app's own
 * CSS + `data-app-*` reads react in place.
 */
export function pushKnobToInlineRoot(root: HTMLElement, key: string, value: string): void {
  const name = appKnobKebab(key);
  if (/(?:Color|Accent)$/.test(key)) root.style.setProperty(`--${name}`, value);
  else root.setAttribute(`data-${name}`, value);
}

/** Hard-reload the app frame — its vault access just changed under it. */
export function reloadAppFrame(): void {
  const frame = appFrame();
  if (!frame) return;
  // Re-setting src is the one reload a cross-origin frame permits.
  const src = frame.src;
  frame.src = src;
}

/** Poll a just-started automation run to completion (6-minute ceiling). */
export async function waitForAutomationRun(runId: string): Promise<CentraidAutomationRunRecord> {
  const deadline = Date.now() + 6 * 60 * 1000;
  while (Date.now() < deadline) {
    const rec = await readAutomationRun({ runId });
    if (rec && rec.endedAt !== undefined) return rec;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error('run did not finish within 6 minutes');
}

/** Build the VaultScreen props for one app's consent pane (all gateway I/O). */
export function buildVaultProps(
  appId: string,
  block: VaultBlockDTO,
  cbs: {
    onAccessChanged?: () => void;
    onParkedCount?: (count: number) => void;
    showToast?: (message: string) => void;
  },
): VaultBridgeProps {
  return {
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
      // `vaultApps()` rows key on `.name` (the enrollment slug, == `appId`
      // here); `.appId` is the vault's internal row id, which is what a
      // parked entry's `callerId` matches on (`caller`, the display name,
      // no longer necessarily equals the slug — issue: parked-invocation
      // trust legibility).
      const enrolledAppId = apps.find((a) => a.name === appId)?.appId;
      return {
        demo: demoApps.find((d) => d.appId === appId),
        grants: apps.find((a) => a.name === appId)?.grants ?? [],
        parked: allParked.filter((p) => p.callerKind === 'app' && p.callerId === enrolledAppId),
        vaultName: s.name,
      };
    },
    revoke: (grantId) => revokeVaultGrant({ grantId }).then(() => undefined),
    ...(cbs.onAccessChanged ? { onAccessChanged: cbs.onAccessChanged } : {}),
    ...(cbs.onParkedCount ? { onParkedCount: cbs.onParkedCount } : {}),
    ...(cbs.showToast ? { showToast: cbs.showToast } : {}),
  };
}
