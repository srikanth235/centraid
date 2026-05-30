import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { gatewayTemplatesCacheDir, LOCAL_GATEWAY_ID } from './gateway-paths.js';
import { ensureLocalGateway, listGateways, resolveGateway } from './gateway-store.js';

/**
 * Persisted desktop settings live at `<userData>/centraid-settings.json`
 * with mode `0600`. After issue #109 it carries only UI preferences and
 * a pointer at the active gateway — connection state (gateway URL,
 * token, workspace path) is per-gateway and lives under
 * `<userData>/gateways/<id>/` (URLs / labels) and the OS keychain
 * (tokens). See `gateway-store.ts`.
 *
 * Two shapes coexist here:
 *   - **Persisted form** (`PersistedSettings`): exactly what's
 *     serialized. Just the active gateway pointer + UI-level prefs.
 *   - **Effective form** (`DesktopSettings`, returned by `loadSettings`):
 *     the persisted fields, plus everything derived from the active
 *     gateway — `gatewayUrl`, `gatewayToken`, `appsDir`. App *code* now
 *     lives in the gateway's git store (issue #137), so there is no
 *     `workspaceDir`; `appsDir` holds only per-app data.
 *     Every IPC handler that needs to act against the active gateway
 *     reads the effective form; that's why the shape didn't shrink
 *     when `runtimeMode` / `remoteGateway*` left it.
 */

export interface PersistedSettings {
  /** Active gateway id. Defaults to `'local'` on a fresh install. */
  activeGatewayId: string;
  /** Optional URL the home shelf hits for remote-template updates. */
  remoteTemplatesUrl?: string;
  /** Model id used by the app-view agentic chat. */
  chatModel?: string;
  /**
   * ISO timestamp of the most recent Claude Code / Codex credential
   * auto-import. Empty/undefined on first launch — main.ts uses that
   * as the trigger to run the importer once.
   */
  authImportedAt?: string;
  /**
   * ISO timestamp the user finished the first-run onboarding (set their
   * own profile name + avatar color). Absent on a fresh install — the
   * renderer reads this as the gate for showing the onboarding view
   * instead of going straight to home. Once written it's permanent;
   * a returning user always lands on home.
   *
   * We intentionally key on settings (not on the profile's `displayName`)
   * because the profile is auto-created on boot for backend reasons
   * (workspace dir, in-process runtime resolution), and we don't want
   * the auto-created placeholder to ever read as "user has personalized".
   */
  onboardingCompletedAt?: string;
}

export interface DesktopSettings {
  /** OpenClaw gateway base URL — e.g. http://127.0.0.1:18789. (Formerly
   * inherited from `@centraid/builder-harness`'s `HarnessConfig`; inlined
   * here in #141 Phase 5 so the desktop drops that dependency.) */
  gatewayUrl: string;
  /**
   * Bearer token sent as `Authorization: Bearer <token>` to the gateway.
   * Empty string disables the header (works only against loopback gateways
   * configured with `auth.mode: "none"`).
   */
  gatewayToken?: string;
  /** Persisted — the gateway the renderer is currently pointing at. */
  activeGatewayId: string;
  /** Derived — `<userData>/gateways/<active>/apps/` (per-app data storage). */
  appsDir: string;
  /**
   * Derived — kind of the active gateway. `'local'` means the
   * in-process runtime owns the URL/token; `'remote'` means the URL
   * comes from the active gateway's `profile.json` and the token
   * comes from the OS keychain.
   */
  activeGatewayKind: 'local' | 'remote';
  /** Derived — the active gateway's user-facing label. */
  activeGatewayLabel: string;
  /**
   * Derived — the active profile's friendly name. Per #113, profiles carry
   * an optional `displayName` that defaults to `label` at read time, so this
   * field is always populated (often equal to `activeGatewayLabel`).
   */
  activeProfileDisplayName: string;
  /**
   * Derived — the active profile's avatar color (`#RRGGBB`). Defaults to a
   * deterministic palette pick keyed by gateway id when the profile hasn't
   * explicitly set one.
   */
  activeProfileAvatarColor: string;
  /** UI prefs (unchanged from earlier shapes). */
  remoteTemplatesUrl?: string;
  chatModel?: string;
  authImportedAt?: string;
  /**
   * ISO timestamp the user finished first-run onboarding. Absent on a
   * fresh install — the renderer gates on this to show onboarding
   * before home.
   */
  onboardingCompletedAt?: string;
}

const FILE_NAME = 'centraid-settings.json';

function settingsPath(): string {
  return path.join(app.getPath('userData'), FILE_NAME);
}

function persistedDefaults(): PersistedSettings {
  return {
    activeGatewayId: LOCAL_GATEWAY_ID,
  };
}

/**
 * Type-narrow a raw `settings.json` blob into `PersistedSettings`.
 * Unknown fields are silently dropped — defensive parsing for malformed
 * writes, not migration. Centraid is v0; there's no prior on-disk
 * shape to support.
 */
function narrow(raw: Record<string, unknown>): PersistedSettings {
  const base = persistedDefaults();
  const activeRaw = raw.activeGatewayId;
  return {
    activeGatewayId:
      typeof activeRaw === 'string' && activeRaw.length > 0 ? activeRaw : base.activeGatewayId,
    ...(typeof raw.remoteTemplatesUrl === 'string'
      ? { remoteTemplatesUrl: raw.remoteTemplatesUrl }
      : {}),
    ...(typeof raw.chatModel === 'string' ? { chatModel: raw.chatModel } : {}),
    ...(typeof raw.authImportedAt === 'string' ? { authImportedAt: raw.authImportedAt } : {}),
    ...(typeof raw.onboardingCompletedAt === 'string'
      ? { onboardingCompletedAt: raw.onboardingCompletedAt }
      : {}),
  };
}

async function readPersisted(): Promise<PersistedSettings> {
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return narrow(parsed);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[centraid] failed to read settings:', err);
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

async function resolveEffective(p: PersistedSettings): Promise<DesktopSettings> {
  // The local gateway must exist before we resolve — its profile
  // is auto-created on first read. If the persisted `activeGatewayId`
  // is stale (gateway was removed externally), fall back to local
  // rather than crashing the whole settings read.
  await ensureLocalGateway();
  let resolved = await resolveGateway(p.activeGatewayId);
  if (!resolved) {
    console.warn(
      `[centraid] active gateway "${p.activeGatewayId}" not found; falling back to local.`,
    );
    resolved = await resolveGateway(LOCAL_GATEWAY_ID);
  }
  if (!resolved) {
    // Should be impossible after ensureLocalGateway, but TypeScript
    // can't see that. Throw with a useful message.
    throw new Error('Local gateway resolution failed unexpectedly.');
  }
  // For local gateways, the URL/token are minted by the in-process
  // runtime. If the runtime hasn't started yet we still return the
  // settings (with empty URL/token) so boot-time code paths that just
  // need `appsDir` don't deadlock waiting for it.
  if (resolved.profile.kind === 'local' && !resolved.url) {
    const { ensureLocalRuntime } = await import('./local-runtime.js');
    const handle = await ensureLocalRuntime(resolved.profile.id);
    resolved = {
      ...resolved,
      url: handle.url,
      token: handle.token,
    };
  }
  return {
    activeGatewayId: resolved.profile.id,
    activeGatewayKind: resolved.profile.kind,
    activeGatewayLabel: resolved.profile.label,
    // `readProfile` thread defaults — these are always populated.
    activeProfileDisplayName: resolved.profile.displayName ?? resolved.profile.label,
    activeProfileAvatarColor: resolved.profile.avatarColor ?? '#5B8DEF',
    appsDir: resolved.appsDir,
    gatewayUrl: resolved.url,
    gatewayToken: resolved.token,
    ...(p.remoteTemplatesUrl !== undefined ? { remoteTemplatesUrl: p.remoteTemplatesUrl } : {}),
    ...(p.chatModel !== undefined ? { chatModel: p.chatModel } : {}),
    ...(p.authImportedAt !== undefined ? { authImportedAt: p.authImportedAt } : {}),
    ...(p.onboardingCompletedAt !== undefined
      ? { onboardingCompletedAt: p.onboardingCompletedAt }
      : {}),
  };
}

export async function loadSettings(): Promise<DesktopSettings> {
  const persisted = await readPersisted();
  return resolveEffective(persisted);
}

/**
 * Read the persisted settings WITHOUT resolving the active gateway.
 * Used by code that needs the raw `activeGatewayId` pointer before
 * (or instead of) booting the in-process runtime — currently only
 * the test surface.
 */
export async function loadPersistedSettings(): Promise<PersistedSettings> {
  return readPersisted();
}

/**
 * Patch the persisted settings. Connection state — gateway URL /
 * token / appsDir — is NOT settable through here; those go
 * through the gateway-store IPCs (`gateways:add`, `gateways:rename`,
 * etc.). The patch is rejected for any of those fields with an error
 * loud enough to fail fast in tests.
 */
export async function saveSettings(patch: Partial<DesktopSettings>): Promise<DesktopSettings> {
  const forbidden = [
    'appsDir',
    'gatewayUrl',
    'gatewayToken',
    'activeGatewayKind',
    'activeGatewayLabel',
  ] as const;
  for (const key of forbidden) {
    if (key in patch) {
      throw new Error(
        `Cannot patch "${key}" through saveSettings — use the gateways IPC surface instead.`,
      );
    }
  }
  const current = await readPersisted();
  const next: PersistedSettings = {
    activeGatewayId: patch.activeGatewayId?.trim() || current.activeGatewayId,
    ...(patch.remoteTemplatesUrl !== undefined
      ? { remoteTemplatesUrl: patch.remoteTemplatesUrl }
      : current.remoteTemplatesUrl !== undefined
        ? { remoteTemplatesUrl: current.remoteTemplatesUrl }
        : {}),
    ...(patch.chatModel !== undefined
      ? { chatModel: patch.chatModel }
      : current.chatModel !== undefined
        ? { chatModel: current.chatModel }
        : {}),
    ...(patch.authImportedAt !== undefined
      ? { authImportedAt: patch.authImportedAt }
      : current.authImportedAt !== undefined
        ? { authImportedAt: current.authImportedAt }
        : {}),
    ...(patch.onboardingCompletedAt !== undefined
      ? { onboardingCompletedAt: patch.onboardingCompletedAt }
      : current.onboardingCompletedAt !== undefined
        ? { onboardingCompletedAt: current.onboardingCompletedAt }
        : {}),
  };
  await writePersisted(next);
  return resolveEffective(next);
}

/**
 * Public helper — used by the gateway IPCs to flip the active id.
 * Identical wire format to `saveSettings({ activeGatewayId })` but
 * crashes loudly if the requested id doesn't resolve, so the caller
 * doesn't write an unresolvable pointer.
 */
export async function setActiveGatewayId(id: string): Promise<DesktopSettings> {
  if (!(await listGateways()).some((g) => g.id === id)) {
    throw new Error(`Cannot activate unknown gateway: ${id}`);
  }
  return saveSettings({ activeGatewayId: id });
}

/**
 * Where remote-fetched template copies are cached for a given gateway.
 * Per-gateway (issue #109) so the gateway directory is the complete
 * record of that gateway's local state — `rm -rf gateways/<id>/` wipes
 * everything including downloaded templates. Today the
 * `remoteTemplatesUrl` setting is single-valued (one feed per machine),
 * so the cache content will usually be identical across gateways —
 * the per-gateway slot future-proofs per-gateway template feeds at
 * the cost of duplicate bytes on disk in the single-feed case.
 */
export function templatesCacheDir(activeGatewayId: string): string {
  return gatewayTemplatesCacheDir(activeGatewayId);
}
