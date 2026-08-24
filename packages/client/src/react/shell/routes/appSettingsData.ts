import { ENRICH_CAPABILITY_DOMAIN } from "../../../enrich-policy.js";
import type { EnrichDomain } from "../../../enrich-policy.js";
import {
  appSettings,
  appSettingWrite,
  approveVaultGrant,
  confirmVaultParked,
  readAutomationTurn,
  revokeVaultGrant,
  vaultApps,
  vaultDemoLoad,
  vaultDemoPurge,
  vaultDemoStatus,
  vaultParked,
  vaultStatus,
  getEffectiveEnrichPolicy,
  listEnrichProfiles,
  auth,
  authHeaders,
  doFetch,
  enc,
} from "../../../gateway-client.js";
import type { VaultDemoApp, VaultScope } from "../../../gateway-client.js";
import type {
  VaultBlockDTO,
  VaultBridgeProps,
} from "../../screen-contracts.js";
import type { AppEnrichmentCapability } from "../../screens/AppEnrichmentSurface.js";

// The gateway I/O + manifest parsing behind the React app-settings popover —
// the successor to the helpers that lived in the deleted app-appview.ts /
// app-vault.ts. Pure/injected so AppSettingsController can stay declarative.

/** One manifest-declared appearance knob (`app.json#knobs[]`). */
export interface AppKnob {
  key: string;
  label: string;
  type: "segmented" | "swatch";
  default: string;
  options: { value: string; label: string }[];
}

export interface AppKnobsManifest {
  version: number;
  knobs: AppKnob[];
}

/**
 * Fetch the app's own `app.json` (next to its index.html), or null. Read
 * straight off the gateway with the renderer's own credential (#799):
 * no per-app browser session fronts this read, and the manifest is the source
 * for the appearance knobs and the vault consent block the settings popover
 * renders.
 */
export async function fetchAppManifestRaw(
  appId: string
): Promise<Record<string, unknown> | null> {
  try {
    const { baseUrl, token } = await auth();
    const res = await doFetch(baseUrl, `/centraid/${enc(appId)}/app.json`, {
      method: "GET",
      headers: authHeaders(token),
    });
    if (!res.ok) return null;
    const parsed = (await res.json()) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Parse the appearance-knobs array out of a fetched manifest. */
export function knobsManifestFrom(
  raw: Record<string, unknown> | null
): AppKnobsManifest | null {
  if (!raw || !Array.isArray(raw.knobs)) return null;
  const version =
    typeof raw.manifestVersion === "number" ? raw.manifestVersion : 1;
  return { version, knobs: raw.knobs as AppKnob[] };
}

/** Parse the manifest `vault` request block, if declared + sound. */
export function manifestVaultBlock(
  raw: Record<string, unknown> | null
): VaultBlockDTO | null {
  if (!raw || typeof raw !== "object") return null;
  const vault = (raw as { vault?: unknown }).vault;
  if (!vault || typeof vault !== "object") return null;
  const v = vault as Record<string, unknown>;
  if (typeof v.purpose !== "string" || !Array.isArray(v.scopes)) return null;
  return {
    purpose: v.purpose,
    why: typeof v.why === "string" ? v.why : "",
    scopes: v.scopes as VaultScope[],
  };
}

/** Read the app's stored knob values from its settings.json (strings only). */
export async function fetchAppKnobValues(
  appId: string
): Promise<Record<string, string>> {
  try {
    const settings = await appSettings({ id: appId });
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(settings)) {
      if (typeof value === "string" && !key.startsWith("__")) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** Persist one knob value (the runtime kebab-cases at bake time). */
export async function writeAppKnobValue(
  appId: string,
  key: string,
  value: string
): Promise<void> {
  await appSettingWrite({ id: appId, key, value });
}

// Settings key (camelCase, e.g. `appFont`) → the kebab name shared by the
// data-attr and CSS-var paths. Mirrors camelTailToKebab in app-engine's
// settings-merge so a live edit lands on the same target a reload will bake.
function appKnobKebab(key: string): string {
  if (key === "appColor" || key === "appAccent") return "app-identity";
  const tail = key.startsWith("app") ? key.slice(3) : key;
  return `app-${tail.charAt(0).toLowerCase()}${tail.slice(1).replace(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`)}`;
}

/**
 * Live-push a knob to an inline app's root element (#505). Keys ending
 * Color/Accent are continuous colour values → CSS vars; the rest are discrete
 * states → data attributes, which keeps a live edit and a reload identical.
 * Applied straight to the element the inline app reads: the app's own CSS +
 * `data-app-*` reads react in place.
 */
export function pushKnobToInlineRoot(
  root: HTMLElement,
  key: string,
  value: string
): void {
  const name = appKnobKebab(key);
  if (/(?:Color|Accent)$/u.test(key))
    root.style.setProperty(`--${name}`, value);
  else root.setAttribute(`data-${name}`, value);
}

/** Poll a just-started automation run to completion (6-minute ceiling). */
export async function waitForAutomationRun(
  runId: string
): Promise<CentraidAutomationTurnRecord> {
  const deadline = Date.now() + 6 * 60 * 1000;
  // This is one run's settlement timeline; start the next observation only
  // after the previous status and retry interval have completed.
  const poll = async (): Promise<CentraidAutomationTurnRecord> => {
    if (Date.now() >= deadline)
      throw new Error("run did not finish within 6 minutes");
    const rec = await readAutomationTurn({ turnId: runId });
    if (rec && rec.endedAt !== undefined) return rec;
    await new Promise((resolve) => {
      setTimeout(resolve, 1500);
    });
    return poll();
  };
  return poll();
}

/** Build the VaultScreen props for one app's consent pane (all gateway I/O). */
export function buildVaultProps(
  appId: string,
  block: VaultBlockDTO,
  cbs: {
    onAccessChanged?: () => void;
    onParkedCount?: (count: number) => void;
    showToast?: (message: string) => void;
  }
): VaultBridgeProps {
  return {
    block,
    confirm: (invocationId, approve) =>
      confirmVaultParked({ approve, invocationId }).then(() => undefined),
    demoLoad: () => vaultDemoLoad(appId).then(() => undefined),
    demoPurge: () => vaultDemoPurge(appId).then(() => undefined),
    grant: () =>
      approveVaultGrant({
        appId,
        purpose: block.purpose,
        scopes: block.scopes,
      }).then(() => undefined),
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
        parked: allParked.filter(
          (p) => p.callerKind === "app" && p.callerId === enrolledAppId
        ),
        vaultName: s.name,
      };
    },
    revoke: (grantId) => revokeVaultGrant({ grantId }).then(() => undefined),
    ...(cbs.onAccessChanged ? { onAccessChanged: cbs.onAccessChanged } : {}),
    ...(cbs.onParkedCount ? { onParkedCount: cbs.onParkedCount } : {}),
    ...(cbs.showToast ? { showToast: cbs.showToast } : {}),
  };
}

/*
 * The app popover's Enrichment surface (#807).
 *
 * An app is bound to a data-shape DOMAIN, not to a capability: Photos holds
 * photos, Docs holds documents, and the capability list of each domain is the
 * gateway's to say. The map below is that binding and nothing else — every
 * word the surface renders comes from the effective-policy read and the
 * profile list, so a gateway that grows a capability shows it without a client
 * release.
 */
const ENRICH_DOMAIN_BY_APP: Readonly<Record<string, EnrichDomain>> = {
  docs: "docs",
  photos: "photos",
};

/** The enrichment domain this app's data belongs to, when it has one. */
export function enrichDomainForApp(appId: string): EnrichDomain | undefined {
  return ENRICH_DOMAIN_BY_APP[appId];
}

/** Every capability of one domain, in the vocabulary's own order. */
function capabilitiesOf(domain: EnrichDomain): string[] {
  return Object.keys(ENRICH_CAPABILITY_DOMAIN).filter(
    (capability) => ENRICH_CAPABILITY_DOMAIN[capability] === domain
  );
}

/**
 * What the gateway's ONE resolver would answer for this app's domain, per
 * capability, joined to the profile each answer names. Nothing is folded here:
 * an unreachable gateway rejects, and the surface says so.
 */
export async function loadAppEnrichment(
  domain: EnrichDomain
): Promise<AppEnrichmentCapability[]> {
  const capabilities = capabilitiesOf(domain);
  const [profiles, answers] = await Promise.all([
    listEnrichProfiles(),
    Promise.all(
      capabilities.map((capability) =>
        getEffectiveEnrichPolicy({ capability, domain })
      )
    ),
  ]);
  return capabilities.map((capability, index) => {
    const effective = answers[index]?.effective ?? null;
    return {
      capability,
      effective,
      // A built-in profile's id is the same string for every capability, so
      // profile identity is the PAIR (engine-profiles.ts), never the id alone.
      profile: effective
        ? profiles.find(
            (entry) =>
              entry.capability === capability &&
              entry.id === effective.profileId
          )
        : undefined,
    };
  });
}
