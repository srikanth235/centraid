import { ENRICH_CAPABILITY_DOMAIN } from "../../../enrich-policy.js";
import type { EnrichDomain } from "../../../enrich-policy.js";
import {
  appSettings,
  appSettingWrite,
  confirmVaultParked,
  readAutomationTurn,
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

// Gateway I/O + manifest parsing behind the app-settings popover. Injected
// so AppSettingsController can stay declarative.

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

/** Fetch `app.json` with the renderer's credential (#799) — no per-app browser session. */
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

export function knobsManifestFrom(
  raw: Record<string, unknown> | null
): AppKnobsManifest | null {
  if (!raw || !Array.isArray(raw.knobs)) return null;
  const version =
    typeof raw.manifestVersion === "number" ? raw.manifestVersion : 1;
  return { version, knobs: raw.knobs as AppKnob[] };
}

export function manifestVaultBlock(
  raw: Record<string, unknown> | null
): VaultBlockDTO | null {
  if (!raw || typeof raw !== "object") return null;
  const vault = (raw as { vault?: unknown }).vault;
  if (!vault || typeof vault !== "object") return null;
  const v = vault as Record<string, unknown>;
  if (!Array.isArray(v.scopes)) return null;
  return {
    why: typeof v.why === "string" ? v.why : "",
    scopes: v.scopes as VaultScope[],
  };
}

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

export async function writeAppKnobValue(
  appId: string,
  key: string,
  value: string
): Promise<void> {
  await appSettingWrite({ id: appId, key, value });
}

// Settings key (camelCase) → kebab shared by data-attr and CSS-var paths.
// Mirrors camelTailToKebab in app-engine settings-merge so a live edit lands
// on the same target a reload will bake.
function appKnobKebab(key: string): string {
  if (key === "appColor" || key === "appAccent") return "app-identity";
  const tail = key.startsWith("app") ? key.slice(3) : key;
  return `app-${tail.charAt(0).toLowerCase()}${tail.slice(1).replace(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`)}`;
}

/** Live-push (#505). Color/Accent → CSS vars; the rest → data attributes. */
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

export async function waitForAutomationRun(
  runId: string
): Promise<CentraidAutomationTurnRecord> {
  const deadline = Date.now() + 6 * 60 * 1000;
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
    loadData: async () => {
      const s = await vaultStatus().catch(() => undefined);
      if (!s) return null;
      const [apps, allParked, demoApps] = await Promise.all([
        vaultApps(),
        vaultParked(),
        vaultDemoStatus().catch(() => [] as VaultDemoApp[]),
      ]);
      // `vaultApps()` rows key on `.name` (enrollment slug == `appId`);
      // `.appId` is the vault's internal row id, which parked `callerId`
      // matches on.
      const enrolledAppId = apps.find((a) => a.name === appId)?.appId;
      return {
        demo: demoApps.find((d) => d.appId === appId),
        parked: allParked.filter(
          (p) => p.callerKind === "app" && p.callerId === enrolledAppId
        ),
        vaultName: s.name,
      };
    },
    ...(cbs.onAccessChanged ? { onAccessChanged: cbs.onAccessChanged } : {}),
    ...(cbs.onParkedCount ? { onParkedCount: cbs.onParkedCount } : {}),
    ...(cbs.showToast ? { showToast: cbs.showToast } : {}),
  };
}

/** App → data-shape domain, not a capability list (#807). */
const ENRICH_DOMAIN_BY_APP: Readonly<Record<string, EnrichDomain>> = {
  docs: "docs",
  photos: "photos",
};

export function enrichDomainForApp(appId: string): EnrichDomain | undefined {
  return ENRICH_DOMAIN_BY_APP[appId];
}

function capabilitiesOf(domain: EnrichDomain): string[] {
  return Object.keys(ENRICH_CAPABILITY_DOMAIN).filter(
    (capability) => ENRICH_CAPABILITY_DOMAIN[capability] === domain
  );
}

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
      // Built-in profile id is the same string for every capability: identity
      // is the pair (engine-profiles.ts), never the id alone.
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
