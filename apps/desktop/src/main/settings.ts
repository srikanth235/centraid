import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { clampAlertSeconds } from './gateway-monitor-core.js';
import { gatewayTemplatesCacheDir, LOCAL_GATEWAY_ID } from './gateway-paths.js';
import { ensureLocalGateway, listGateways, resolveGateway } from './gateway-store.js';
import { mergePersistedSettings } from './settings-merge.js';

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
 *     gateway — `gatewayUrl`, `gatewayToken`. App *code* now
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
  /**
   * Per-runner chat-model selection for the app-view agentic chat, keyed by
   * runner kind (`'codex'` | `'claude-code'` | …). A model id only means
   * something inside its own runner, so the choice is scoped to the runner
   * rather than stored as one global id — switching the active agent can
   * never leave a foreign model id selected, and each agent remembers its
   * own pick. A missing key → that runner uses its gateway default.
   */
  chatModelByRunner?: Record<string, string>;
  /**
   * The active vault the client addresses on each gateway (issue #289),
   * keyed by gateway id. The server no longer holds an active-vault
   * pointer — the client owns it and sends it as `x-centraid-vault`.
   * Switching vaults is a pure client-side pointer flip; a missing entry
   * means "let the gateway pick" (the device's sole enrollment, or the
   * default vault for the shared-bearer local transport).
   */
  activeVaultByGateway?: Record<string, string>;
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
  /**
   * Gateway down-alert threshold in seconds (gateway-monitor.ts): notify
   * once the active gateway has been continuously unreachable this long.
   * Absent → {@link DEFAULT_ALERT_SECONDS} (2 minutes). Clamped to
   * [MIN_ALERT_SECONDS, MAX_ALERT_SECONDS] on read and write.
   */
  gatewayAlertSeconds?: number;
  /** Master switch for the gateway down alert. Absent → enabled. */
  gatewayAlertsEnabled?: boolean;
  /**
   * The changelog version the user has already seen — the running build's
   * version at the last time the "What's new" modal auto-opened. The renderer
   * auto-opens the modal once whenever `app.getVersion()` differs from this,
   * then writes the new version back. Absent = never seen (fresh install).
   */
  changelogSeenVersion?: string;
}

export interface DesktopSettings {
  /** Remote gateway base URL — e.g. http://127.0.0.1:8765. (Formerly
   * inherited from `@centraid/agent-harness`'s `HarnessConfig`; inlined
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
  /**
   * The vault the renderer is addressing on the active gateway (issue
   * #289), or `undefined` to let the gateway pick. Sent as the
   * `x-centraid-vault` header on every request.
   */
  activeVaultId?: string;
  /** Derived — `<userData>/gateways/<active>/apps/` (per-app data storage). */
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
  /** Per-runner chat-model selection (keyed by runner kind). See
   * {@link PersistedSettings.chatModelByRunner}. */
  chatModelByRunner?: Record<string, string>;
  /**
   * ISO timestamp the user finished first-run onboarding. Absent on a
   * fresh install — the renderer gates on this to show onboarding
   * before home.
   */
  onboardingCompletedAt?: string;
  /** Gateway down-alert threshold in seconds (absent → 2-minute default). */
  gatewayAlertSeconds?: number;
  /** Master switch for the gateway down alert (absent → enabled). */
  gatewayAlertsEnabled?: boolean;
  /** Changelog version last shown by the "What's new" auto-open (absent → never). */
  changelogSeenVersion?: string;
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
 * Defensive parse of the persisted `chatModelByRunner` map: keep only
 * `string → non-empty-string` entries, drop everything else. Returns
 * `{ chatModelByRunner }` ready to spread, or `undefined` when there's
 * nothing valid to carry. Not migration — just malformed-write hygiene.
 */
function sanitizeModelMap(raw: unknown): { chatModelByRunner: Record<string, string> } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [kind, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value.length > 0) out[kind] = value;
  }
  return Object.keys(out).length ? { chatModelByRunner: out } : undefined;
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
    // A legacy global `chatModel` string (pre-#188) is intentionally NOT
    // migrated into `chatModelByRunner`: Centraid is v0/pre-release with no
    // on-disk-shape compatibility guarantees, and a stale global id can't be
    // safely attributed to a specific runner anyway. It's dropped; the picker
    // falls back to each runner's gateway default until the user re-picks.
    ...sanitizeModelMap(raw.chatModelByRunner),
    ...sanitizeVaultMap(raw.activeVaultByGateway),
    ...(typeof raw.onboardingCompletedAt === 'string'
      ? { onboardingCompletedAt: raw.onboardingCompletedAt }
      : {}),
    ...(() => {
      const clamped = clampAlertSeconds(raw.gatewayAlertSeconds);
      return clamped !== undefined ? { gatewayAlertSeconds: clamped } : {};
    })(),
    ...(typeof raw.gatewayAlertsEnabled === 'boolean'
      ? { gatewayAlertsEnabled: raw.gatewayAlertsEnabled }
      : {}),
    ...(typeof raw.changelogSeenVersion === 'string'
      ? { changelogSeenVersion: raw.changelogSeenVersion }
      : {}),
  };
}

/**
 * Defensive parse of `activeVaultByGateway` (issue #289): keep only
 * `string → non-empty-string` entries. Malformed-write hygiene, not
 * migration.
 */
function sanitizeVaultMap(
  raw: unknown,
): { activeVaultByGateway: Record<string, string> } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [gatewayId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value.length > 0) out[gatewayId] = value;
  }
  return Object.keys(out).length ? { activeVaultByGateway: out } : undefined;
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
    const { ensureLocalGateway } = await import('./local-gateway.js');
    const handle = await ensureLocalGateway(resolved.profile.id);
    resolved = {
      ...resolved,
      url: handle.url,
      token: handle.token,
    };
  }
  // The vault the client addresses on this gateway (#289) — client-owned,
  // keyed by gateway id. Undefined = let the gateway pick.
  const activeVaultId = p.activeVaultByGateway?.[resolved.profile.id];
  return {
    activeGatewayId: resolved.profile.id,
    activeGatewayKind: resolved.profile.kind,
    activeGatewayLabel: resolved.profile.label,
    // `readProfile` thread defaults — these are always populated.
    activeProfileDisplayName: resolved.profile.displayName ?? resolved.profile.label,
    activeProfileAvatarColor: resolved.profile.avatarColor ?? '#5B8DEF',
    gatewayUrl: resolved.url,
    gatewayToken: resolved.token,
    ...(activeVaultId !== undefined ? { activeVaultId } : {}),
    ...(p.remoteTemplatesUrl !== undefined ? { remoteTemplatesUrl: p.remoteTemplatesUrl } : {}),
    ...(p.chatModelByRunner !== undefined ? { chatModelByRunner: p.chatModelByRunner } : {}),
    ...(p.onboardingCompletedAt !== undefined
      ? { onboardingCompletedAt: p.onboardingCompletedAt }
      : {}),
    ...(p.gatewayAlertSeconds !== undefined ? { gatewayAlertSeconds: p.gatewayAlertSeconds } : {}),
    ...(p.gatewayAlertsEnabled !== undefined
      ? { gatewayAlertsEnabled: p.gatewayAlertsEnabled }
      : {}),
    ...(p.changelogSeenVersion !== undefined
      ? { changelogSeenVersion: p.changelogSeenVersion }
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
  const next = mergePersistedSettings(current, patch);
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
 * Point the client at another vault ON THE ACTIVE GATEWAY (issue #289).
 * This is a pure client-side pointer flip — no server call, no re-root:
 * every subsequent request just carries a different `x-centraid-vault`
 * header. Pass `undefined` to clear (let the gateway pick). Keyed by
 * gateway id, so switching gateways restores each one's last vault.
 */
export async function setActiveVaultId(vaultId: string | undefined): Promise<DesktopSettings> {
  const persisted = await readPersisted();
  const activeGatewayId = persisted.activeGatewayId;
  const map = { ...persisted.activeVaultByGateway };
  if (vaultId === undefined || vaultId.length === 0) delete map[activeGatewayId];
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
