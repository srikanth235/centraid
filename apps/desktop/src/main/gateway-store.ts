// Gateway profile registry + active-gateway selection.
//
// Issue #109. Centraid is multi-gateway: one local in-process runtime
// (id `'local'`, always present) plus 0..N remote gateways the user
// adds via the Settings → Gateways panel. Each gateway gets a
// `profile.json` describing its identity and a per-gateway subtree
// under `<userData>/gateways/<id>/`.
//
// This module is the single source of truth for:
//   - listing profiles (scans `gateways/` + reads each `profile.json`)
//   - resolving the active gateway (looked up from `settings.json`)
//   - adding/removing/renaming remote gateways (lifecycle IPCs)
//   - resolving "effective URL + token" — for local that's the
//     in-process runtime's ephemeral URL + per-launch token; for
//     remote it's the profile's stored URL + the keychain token.
//
// The local gateway is special-cased throughout:
//   - id is the fixed string `'local'`
//   - profile is auto-created on first read if missing
//   - cannot be removed; rename is allowed (label only)
//   - URL/token are minted by the in-process runtime, not persisted

import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  LOCAL_GATEWAY_ID,
  gatewayAppsDir,
  gatewayDir,
  gatewayProfilePath,
  gatewayWorkspaceDir,
  gatewaysRoot,
} from './gateway-paths.js';
import { clearGatewayToken, getGatewayToken, setGatewayToken } from './gateway-secrets.js';

export type GatewayKind = 'local' | 'remote';

export interface GatewayProfile {
  readonly id: string;
  readonly kind: GatewayKind;
  /** Display label shown in the switcher; mutable via renameGateway. */
  readonly label: string;
  /**
   * Optional friendly name distinct from the technical `label`. When unset,
   * `readProfile` fills it from `label` so callers can always read a string.
   * In v0 we keep both fields in case the UX later wants a "long name + short
   * label" split — today the switcher renders this verbatim.
   */
  readonly displayName?: string;
  /**
   * Optional 7-character hex color (`#RRGGBB`) for the avatar disc rendered
   * next to the profile in the switcher + sidebar-head row. When unset,
   * `readProfile` defaults to a deterministic palette pick keyed by `id`,
   * so two profiles never produce the same color on first read unless the
   * user manually sets them that way.
   */
  readonly avatarColor?: string;
  /** Remote endpoint URL. Undefined for the local gateway. */
  readonly url?: string;
  /** ISO timestamp set on first write. */
  readonly createdAt: string;
}

/**
 * 8-color avatar palette. Picked for AA contrast against the dark sidebar
 * background and for being visually distinct from each other at 24×24px.
 * The order matters — `defaultAvatarColor` hashes id into this array.
 */
const AVATAR_PALETTE: readonly string[] = [
  '#5B8DEF', // blue
  '#7C5CFF', // violet
  '#E36AD2', // pink
  '#E5734A', // orange
  '#E0B53D', // amber
  '#4FB077', // green
  '#3FB5C7', // teal
  '#B07A4A', // brown
] as const;

/**
 * Deterministic palette pick from a profile id. Stable across launches —
 * a user who never touches `avatarColor` always sees the same color for
 * the same profile. Hash is FNV-1a 32-bit; cryptographic strength is not
 * needed.
 */
export function defaultAvatarColor(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const idx = (h >>> 0) % AVATAR_PALETTE.length;
  return AVATAR_PALETTE[idx] as string;
}

/** Validate a user-supplied avatar color. Accepts `#RRGGBB` only. */
function isValidAvatarColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

/** Result of `resolveGateway` — profile + paths + effective URL/token. */
export interface ResolvedGateway {
  readonly profile: GatewayProfile;
  readonly workspaceDir: string;
  readonly appsDir: string;
  /** For local: the in-process runtime's URL. For remote: profile.url. */
  readonly url: string;
  /** For local: the per-launch token. For remote: the keychain value (or ''). */
  readonly token: string;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/i;

class GatewayError extends Error {
  constructor(
    public readonly code:
      | 'unknown_gateway'
      | 'local_not_removable'
      | 'invalid_input'
      | 'already_exists',
    message: string,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

/**
 * Per-gateway provider of the local in-process runtime's URL+token.
 * Registered once by `local-runtime.ts`; the closure reads the
 * runtime's handle map at lookup time so a gateway that hasn't been
 * activated yet returns undefined here (and `resolveGateway` returns
 * an empty url/token, which callers in boot-time code paths tolerate).
 */
let localRuntimeInfo: (gatewayId: string) => { url: string; token: string } | undefined = () =>
  undefined;

export function setLocalRuntimeInfoProvider(
  fn: (gatewayId: string) => { url: string; token: string } | undefined,
): void {
  localRuntimeInfo = fn;
}

/** Default label written into a freshly-created local profile. */
const DEFAULT_LOCAL_LABEL = 'My computer';

/**
 * Ensure the `gateways/local/` dir and its `profile.json` exist. Safe
 * to call on every boot — no-op when already present. Returns the
 * persisted profile.
 */
export async function ensureLocalGateway(): Promise<GatewayProfile> {
  const dir = gatewayDir(LOCAL_GATEWAY_ID);
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(gatewayWorkspaceDir(LOCAL_GATEWAY_ID), { recursive: true });
  await fs.mkdir(gatewayAppsDir(LOCAL_GATEWAY_ID), { recursive: true });
  const existing = await readProfile(LOCAL_GATEWAY_ID);
  if (existing) return existing;
  const profile: GatewayProfile = {
    id: LOCAL_GATEWAY_ID,
    kind: 'local',
    label: DEFAULT_LOCAL_LABEL,
    createdAt: new Date().toISOString(),
  };
  await writeProfile(profile);
  return profile;
}

/**
 * Read a profile from disk. Undefined when the file doesn't exist.
 *
 * Read-time defaults: `displayName` falls back to `label`, `avatarColor`
 * falls back to a deterministic palette pick from the id. v0 doesn't
 * migrate older profile.json files — we just thread defaults so callers
 * always see populated fields.
 */
async function readProfile(id: string): Promise<GatewayProfile | undefined> {
  try {
    const raw = await fs.readFile(gatewayProfilePath(id), 'utf8');
    const parsed = JSON.parse(raw) as Partial<GatewayProfile>;
    if (!parsed || typeof parsed !== 'object') return undefined;
    if (parsed.id !== id) return undefined;
    if (parsed.kind !== 'local' && parsed.kind !== 'remote') return undefined;
    if (typeof parsed.label !== 'string' || parsed.label.length === 0) return undefined;
    if (typeof parsed.createdAt !== 'string') return undefined;
    const displayName =
      typeof parsed.displayName === 'string' && parsed.displayName.length > 0
        ? parsed.displayName
        : parsed.label;
    const avatarColor = isValidAvatarColor(parsed.avatarColor)
      ? parsed.avatarColor
      : defaultAvatarColor(parsed.id);
    return {
      id: parsed.id,
      kind: parsed.kind,
      label: parsed.label,
      displayName,
      avatarColor,
      ...(typeof parsed.url === 'string' && parsed.url.length > 0 ? { url: parsed.url } : {}),
      createdAt: parsed.createdAt,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

async function writeProfile(profile: GatewayProfile): Promise<void> {
  const file = gatewayProfilePath(profile.id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(profile, null, 2) + '\n', { mode: 0o600 });
}

/**
 * Enumerate every gateway profile under `gateways/`. Folders whose
 * `profile.json` is missing or corrupt are silently skipped — they
 * usually represent a half-finished migration that the user can
 * either complete (write a profile by re-adding) or wipe by removing
 * the folder.
 */
export async function listGateways(): Promise<GatewayProfile[]> {
  await ensureLocalGateway();
  const entries = await fs.readdir(gatewaysRoot(), { withFileTypes: true }).catch(() => []);
  const profiles: GatewayProfile[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = await readProfile(e.name);
    if (p) profiles.push(p);
  }
  // Stable order: local first, then remote by creation time (oldest
  // first — matches the order the user added them).
  profiles.sort((a, b) => {
    if (a.id === LOCAL_GATEWAY_ID) return -1;
    if (b.id === LOCAL_GATEWAY_ID) return 1;
    return a.createdAt.localeCompare(b.createdAt);
  });
  return profiles;
}

export interface AddGatewayInput {
  /** User-visible label. Trimmed; required. */
  label: string;
  /** Remote endpoint URL. Trimmed; required. */
  url: string;
  /** Bearer token. Stored in keychain, never on disk. Empty = unauthenticated. */
  token: string;
  /** Optional friendly name. Defaults to `label` at read time. */
  displayName?: string;
  /** Optional avatar color as `#RRGGBB`. Defaults to a deterministic palette pick. */
  avatarColor?: string;
}

/**
 * Mint a UUID, persist the profile + token, and create the per-gateway
 * dirs. Caller-side validation is loose — we trim, enforce non-empty
 * label and a parseable URL, but don't probe the gateway here (the UI
 * does its own "Test connection" before calling add).
 */
export async function addGateway(input: AddGatewayInput): Promise<GatewayProfile> {
  const label = input.label.trim();
  const url = input.url.trim();
  if (!label) throw new GatewayError('invalid_input', 'Gateway label cannot be empty.');
  if (!url) throw new GatewayError('invalid_input', 'Gateway URL cannot be empty.');
  try {
    // URL constructor throws on malformed input — the parsed value
    // itself is discarded; we just want the validation side-effect.
    const _ = new URL(url);
    void _;
  } catch {
    throw new GatewayError('invalid_input', `Gateway URL "${url}" is not a valid URL.`);
  }
  const id = randomUUID();
  const displayName = input.displayName?.trim() || label;
  const avatarColor = isValidAvatarColor(input.avatarColor)
    ? input.avatarColor
    : defaultAvatarColor(id);
  const profile: GatewayProfile = {
    id,
    kind: 'remote',
    label,
    displayName,
    avatarColor,
    url,
    createdAt: new Date().toISOString(),
  };
  await fs.mkdir(gatewayDir(id), { recursive: true });
  await fs.mkdir(gatewayWorkspaceDir(id), { recursive: true });
  // appsDir intentionally not created for remote — the directory is
  // unused (the gateway owns its own storage). Path helpers still
  // return the resolved path so handlers don't need kind-specific
  // branching, they just won't write anything there.
  await writeProfile(profile);
  if (input.token.length > 0) {
    await setGatewayToken(id, input.token);
  }
  return profile;
}

/**
 * Mint a UUID and persist a NEW local gateway profile + its workspace +
 * apps dirs. The in-process runtime for this gateway is NOT started —
 * `ensureLocalRuntime(id)` starts on first activation. Used for
 * "create another local workspace" (isolated dev/scratch/per-project
 * locals). The primordial `'local'` gateway is still auto-created on
 * boot by `ensureLocalGateway`; this is purely additive.
 *
 * Profile metadata (`displayName`, `avatarColor`) is optional — read-time
 * defaults fill them in when callers (like the Add Profile form) leave
 * them blank.
 */
export async function addLocalGateway(input: {
  label: string;
  displayName?: string;
  avatarColor?: string;
}): Promise<GatewayProfile> {
  const label = input.label.trim();
  if (!label) throw new GatewayError('invalid_input', 'Gateway label cannot be empty.');
  const id = randomUUID();
  const displayName = input.displayName?.trim() || label;
  const avatarColor = isValidAvatarColor(input.avatarColor)
    ? input.avatarColor
    : defaultAvatarColor(id);
  const profile: GatewayProfile = {
    id,
    kind: 'local',
    label,
    displayName,
    avatarColor,
    createdAt: new Date().toISOString(),
  };
  await fs.mkdir(gatewayDir(id), { recursive: true });
  await fs.mkdir(gatewayWorkspaceDir(id), { recursive: true });
  await fs.mkdir(gatewayAppsDir(id), { recursive: true });
  await writeProfile(profile);
  return profile;
}

/**
 * Patch `displayName` and/or `avatarColor` on an existing profile. Pass
 * the empty string for `displayName` to reset it to `label`-derived
 * default at next read; pass `undefined` to leave the field untouched.
 * `avatarColor` accepts `#RRGGBB` or `undefined`.
 */
export async function updateProfileMetadata(
  id: string,
  patch: { displayName?: string; avatarColor?: string },
): Promise<GatewayProfile> {
  const current = await readProfile(id);
  if (!current) throw new GatewayError('unknown_gateway', `No such gateway: ${id}`);
  const next: GatewayProfile = { ...current };
  if (patch.displayName !== undefined) {
    const trimmed = patch.displayName.trim();
    // Persist explicitly even when equal to label — round-trips intent.
    (next as { displayName: string }).displayName = trimmed.length > 0 ? trimmed : current.label;
  }
  if (patch.avatarColor !== undefined) {
    if (!isValidAvatarColor(patch.avatarColor)) {
      throw new GatewayError(
        'invalid_input',
        `Avatar color "${patch.avatarColor}" must match #RRGGBB.`,
      );
    }
    (next as { avatarColor: string }).avatarColor = patch.avatarColor;
  }
  await writeProfile(next);
  return next;
}

/**
 * Wipe a gateway's directory and (for remote) its keychain entry.
 * Refuses to remove the primordial `'local'` gateway — every install
 * has one, and the active-gateway fallback path in settings depends on
 * it always being there. Non-primordial local gateways (added via
 * `addLocalGateway`) can be removed. Idempotent — missing dir / token
 * is fine.
 */
export async function removeGateway(id: string): Promise<void> {
  if (id === LOCAL_GATEWAY_ID) {
    throw new GatewayError('local_not_removable', 'The default local profile cannot be removed.');
  }
  if (!ID_RE.test(id)) {
    throw new GatewayError('invalid_input', `Invalid gateway id "${id}".`);
  }
  // Best-effort token clear — local gateways have no keychain entry, so
  // the call is a no-op for them.
  await clearGatewayToken(id);
  await fs.rm(gatewayDir(id), { recursive: true, force: true });
}

/** Rename a gateway (label only — id and paths never change). */
export async function renameGateway(id: string, nextLabel: string): Promise<GatewayProfile> {
  const trimmed = nextLabel.trim();
  if (!trimmed) throw new GatewayError('invalid_input', 'Gateway label cannot be empty.');
  const current = await readProfile(id);
  if (!current) throw new GatewayError('unknown_gateway', `No such gateway: ${id}`);
  const next: GatewayProfile = { ...current, label: trimmed };
  await writeProfile(next);
  return next;
}

/**
 * Replace a remote gateway's stored token. Pass empty string to clear.
 * Local gateway tokens are managed by the in-process runtime; calling
 * this with the local id is a no-op.
 */
export async function updateGatewayToken(id: string, token: string): Promise<void> {
  if (id === LOCAL_GATEWAY_ID) return;
  const profile = await readProfile(id);
  if (!profile) throw new GatewayError('unknown_gateway', `No such gateway: ${id}`);
  await setGatewayToken(id, token);
}

/**
 * Resolve a gateway by id into a `ResolvedGateway`. Returns undefined
 * for an unknown id rather than throwing — callers usually fall back
 * to the local gateway in that case.
 */
export async function resolveGateway(id: string): Promise<ResolvedGateway | undefined> {
  const profile = await readProfile(id);
  if (!profile) return undefined;
  if (profile.kind === 'local') {
    const info = localRuntimeInfo(profile.id);
    return {
      profile,
      workspaceDir: gatewayWorkspaceDir(profile.id),
      appsDir: gatewayAppsDir(profile.id),
      url: info?.url ?? '',
      token: info?.token ?? '',
    };
  }
  const token = (await getGatewayToken(profile.id)) ?? '';
  return {
    profile,
    workspaceDir: gatewayWorkspaceDir(profile.id),
    appsDir: gatewayAppsDir(profile.id),
    url: profile.url ?? '',
    token,
  };
}

export { GatewayError };
