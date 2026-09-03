import { promises as fs } from "node:fs";
import path from "node:path";

import { app } from "electron";

import { BRAND } from "@centraid/design";

import { clampAlertSeconds } from "./gateway-monitor-core.js";
import { gatewayTemplatesCacheDir, LOCAL_GATEWAY_ID } from "./gateway-paths.js";
import {
  ensureLocalGateway,
  listGateways,
  resolveGateway,
} from "./gateway-store.js";
import { mergePersistedSettings } from "./settings-merge.js";

/**
 * `<userData>/centraid-settings.json`, mode 0600: UI prefs + active gateway
 * pointer (#109), NOTHING else — connection state lives in gateway-store.ts,
 * secrets in the keychain. `PersistedSettings` serializes; `DesktopSettings`
 * adds active-gateway-derived fields (what IPC handlers read).
 */
export interface PersistedSettings {
  activeGatewayId: string;
  /** Per-gateway vault pointer (#289), sent as `x-centraid-vault`; missing = gateway picks. */
  activeVaultByGateway?: Record<string, string>;
  onboardingCompletedAt?: string;
  gatewayAlertSeconds?: number;
  gatewayAlertsEnabled?: boolean;
  changelogSeenVersion?: string;
  /** Absent → disabled: a fresh install never silently adds itself to login items. No-op on Linux (no Electron `setLoginItemSettings`). */
  launchAtLogin?: boolean;
  offerGatewayService?: boolean;
}

export interface DesktopSettings {
  gatewayUrl: string;
  gatewayToken?: string;
  activeGatewayId: string;
  activeVaultId?: string;
  activeGatewayKind: "local" | "remote";
  activeGatewayLabel: string;
  activeProfileDisplayName: string;
  activeProfileAvatarColor: string;
  onboardingCompletedAt?: string;
  gatewayAlertSeconds?: number;
  gatewayAlertsEnabled?: boolean;
  changelogSeenVersion?: string;
  launchAtLogin?: boolean;
  /** Whether onboarding OFFERS the OS service install (H5 / #468); silent install forbidden. */
  offerGatewayService?: boolean;
}

const FILE_NAME = "centraid-settings.json";

function settingsPath(): string {
  return path.join(app.getPath("userData"), FILE_NAME);
}

function persistedDefaults(): PersistedSettings {
  return {
    activeGatewayId: LOCAL_GATEWAY_ID,
  };
}

function narrow(raw: Record<string, unknown>): PersistedSettings {
  const base = persistedDefaults();
  const activeRaw = raw.activeGatewayId;
  return {
    activeGatewayId:
      typeof activeRaw === "string" && activeRaw.length > 0
        ? activeRaw
        : base.activeGatewayId,
    ...sanitizeVaultMap(raw.activeVaultByGateway),
    ...(typeof raw.onboardingCompletedAt === "string"
      ? { onboardingCompletedAt: raw.onboardingCompletedAt }
      : {}),
    ...(() => {
      const clamped = clampAlertSeconds(raw.gatewayAlertSeconds);
      return clamped === undefined ? {} : { gatewayAlertSeconds: clamped };
    })(),
    ...(typeof raw.gatewayAlertsEnabled === "boolean"
      ? { gatewayAlertsEnabled: raw.gatewayAlertsEnabled }
      : {}),
    ...(typeof raw.changelogSeenVersion === "string"
      ? { changelogSeenVersion: raw.changelogSeenVersion }
      : {}),
    ...(typeof raw.launchAtLogin === "boolean"
      ? { launchAtLogin: raw.launchAtLogin }
      : {}),
    ...(typeof raw.offerGatewayService === "boolean"
      ? { offerGatewayService: raw.offerGatewayService }
      : {}),
  };
}

function sanitizeVaultMap(
  raw: unknown
): { activeVaultByGateway: Record<string, string> } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [gatewayId, value] of Object.entries(
    raw as Record<string, unknown>
  )) {
    if (typeof value === "string" && value.length > 0) out[gatewayId] = value;
  }
  return Object.keys(out).length ? { activeVaultByGateway: out } : undefined;
}

async function readPersisted(): Promise<PersistedSettings> {
  try {
    const raw = await fs.readFile(settingsPath(), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return narrow(parsed);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[centraid] failed to read settings:", error);
    }
    return persistedDefaults();
  }
}

async function writePersisted(next: PersistedSettings): Promise<void> {
  const file = settingsPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}

/** First-run keychain deferral (#603): the local gateway's `safeStorage` mint must not prompt before any UI, so with no `onboardingCompletedAt` resolveEffective returns empty local URL/token instead of booting. */
let localGatewayStartRequested = false;

export function requestLocalGatewayStart(): void {
  localGatewayStartRequested = true;
}

async function resolveEffective(
  p: PersistedSettings
): Promise<DesktopSettings> {
  await ensureLocalGateway();
  let resolved = await resolveGateway(p.activeGatewayId);
  if (!resolved) {
    console.warn(
      `[centraid] active gateway "${p.activeGatewayId}" not found; falling back to local.`
    );
    resolved = await resolveGateway(LOCAL_GATEWAY_ID);
  }
  if (!resolved) {
    // Unreachable after `ensureLocalGateway`, but TypeScript cannot see it.
    throw new Error("Local gateway resolution failed unexpectedly.");
  }
  const deferLocalStart =
    p.onboardingCompletedAt === undefined && !localGatewayStartRequested;
  if (resolved.profile.kind === "local" && !resolved.url && !deferLocalStart) {
    const { ensureLocalGateway: ensureLocalGatewayLocal } =
      await import("./local-gateway.js");
    const handle = await ensureLocalGatewayLocal(resolved.profile.id);
    resolved = {
      ...resolved,
      url: handle.url,
      token: handle.token,
    };
  }
  const activeVaultId = p.activeVaultByGateway?.[resolved.profile.id];
  return {
    activeGatewayId: resolved.profile.id,
    activeGatewayKind: resolved.profile.kind,
    activeGatewayLabel: resolved.profile.label,
    activeProfileDisplayName:
      resolved.profile.displayName ?? resolved.profile.label,
    activeProfileAvatarColor: resolved.profile.avatarColor ?? BRAND,
    gatewayUrl: resolved.url,
    gatewayToken: resolved.token,
    ...(activeVaultId === undefined ? {} : { activeVaultId }),
    ...(p.onboardingCompletedAt === undefined
      ? {}
      : { onboardingCompletedAt: p.onboardingCompletedAt }),
    ...(p.gatewayAlertSeconds === undefined
      ? {}
      : { gatewayAlertSeconds: p.gatewayAlertSeconds }),
    ...(p.gatewayAlertsEnabled === undefined
      ? {}
      : { gatewayAlertsEnabled: p.gatewayAlertsEnabled }),
    ...(p.changelogSeenVersion === undefined
      ? {}
      : { changelogSeenVersion: p.changelogSeenVersion }),
    ...(p.launchAtLogin === undefined
      ? {}
      : { launchAtLogin: p.launchAtLogin }),
    ...(p.offerGatewayService === undefined
      ? {}
      : { offerGatewayService: p.offerGatewayService }),
  };
}

export async function loadSettings(): Promise<DesktopSettings> {
  const persisted = await readPersisted();
  return resolveEffective(persisted);
}

export async function loadPersistedSettings(): Promise<PersistedSettings> {
  return readPersisted();
}

export async function saveSettings(
  patch: Partial<DesktopSettings>
): Promise<DesktopSettings> {
  const forbidden = [
    "gatewayUrl",
    "gatewayToken",
    "activeGatewayKind",
    "activeGatewayLabel",
  ] as const;
  for (const key of forbidden) {
    if (key in patch) {
      throw new Error(
        `Cannot patch "${key}" through saveSettings — use the gateways IPC surface instead.`
      );
    }
  }
  const current = await readPersisted();
  const next = mergePersistedSettings(current, patch);
  await writePersisted(next);
  return resolveEffective(next);
}

export async function setActiveGatewayId(id: string): Promise<DesktopSettings> {
  if (!(await listGateways()).some((g) => g.id === id)) {
    throw new Error(`Cannot activate unknown gateway: ${id}`);
  }
  requestLocalGatewayStart();
  return saveSettings({ activeGatewayId: id });
}

/** Client-side pointer flip (#289): no server call, no re-root; `undefined` clears; keyed by gateway. */
export async function setActiveVaultId(
  vaultId: string | undefined
): Promise<DesktopSettings> {
  const persisted = await readPersisted();
  const activeGatewayId = persisted.activeGatewayId;
  const map = { ...persisted.activeVaultByGateway };
  if (vaultId === undefined || vaultId.length === 0)
    delete map[activeGatewayId];
  else map[activeGatewayId] = vaultId;
  const next: PersistedSettings = {
    ...persisted,
    ...(Object.keys(map).length ? { activeVaultByGateway: map } : {}),
  };
  if (!Object.keys(map).length)
    delete (next as { activeVaultByGateway?: unknown }).activeVaultByGateway;
  await writePersisted(next);
  return resolveEffective(next);
}

export function templatesCacheDir(activeGatewayId: string): string {
  return gatewayTemplatesCacheDir(activeGatewayId);
}
