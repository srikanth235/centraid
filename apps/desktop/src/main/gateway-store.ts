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
import { LOCAL_GATEWAY_ID, gatewayDir, gatewayProfilePath, gatewaysRoot } from './gateway-paths.js';
import { clearGatewayToken, getGatewayToken, setGatewayToken } from './gateway-secrets.js';
import {
  assertDirectUrlAllowed,
  resolveTransport,
  TransportGuardError,
  type GatewayTransport,
} from './transport.js';
import { ensureIrohProxy } from './iroh-dialer.js';

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
  /**
   * Transport tier (issue #289): `local` (in-process), `iroh` (EndpointId
   * over the QUIC tunnel), or `direct` (https/http URL + token). Absent on
   * pre-#289 profiles — `resolveTransport` derives it from kind + url.
   */
  readonly transport?: GatewayTransport;
  /** Remote endpoint URL (direct transport). Undefined for local + iroh. */
  readonly url?: string;
  /**
   * Remote iroh EndpointTicket (iroh transport) — the gateway's EndpointId +
   * relay hint, redeemed from a pairing ticket. Undefined for local + direct.
   */
  readonly endpointTicket?: string;
  /** Remote iroh EndpointId (iroh transport), for display + `devices add`. */
  readonly endpointId?: string;
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

/** Result of `resolveGateway` — profile + effective URL/token. */
export interface ResolvedGateway {
  readonly profile: GatewayProfile;
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
 * Registered once by `local-gateway.ts`; the closure reads the
 * runtime's handle map at lookup time so a gateway that hasn't been
 * activated yet returns undefined here (and `resolveGateway` returns
 * an empty url/token, which callers in boot-time code paths tolerate).
 */
let localGatewayInfo: (gatewayId: string) => { url: string; token: string } | undefined = () =>
  undefined;

export function setLocalGatewayInfoProvider(
  fn: (gatewayId: string) => { url: string; token: string } | undefined,
): void {
  localGatewayInfo = fn;
}

/**
 * Technical fallback label for the auto-created local profile. Not
 * user-facing in normal flow — the renderer gates first launch behind
 * an onboarding view that asks the user to pick their own
 * `displayName`. This label only surfaces if onboarding is somehow
 * bypassed; keeping it terse + neutral so even that degenerate case
 * reads as "system default", not a presumed name.
 */
const DEFAULT_LOCAL_LABEL = 'Local';

/**
 * Ensure the `gateways/local/` dir and its `profile.json` exist. Safe
 * to call on every boot — no-op when already present. Returns the
 * persisted profile.
 *
 * Crucially, the auto-created profile carries NO `displayName` — the
 * field stays unset on disk so the renderer can detect "user has not
 * personalized this profile yet" and route to onboarding. `readProfile`
 * still threads a default displayName at read time (falls back to
 * `label`) so callers always see a populated string, but the on-disk
 * absence is the signal the onboarding flow keys on.
 */
export async function ensureLocalGateway(): Promise<GatewayProfile> {
  const dir = gatewayDir(LOCAL_GATEWAY_ID);
  await fs.mkdir(dir, { recursive: true });
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
 * Read-time defaults: `displayName` falls back to `label` (handles the
 * primordial-local case where `ensureLocalGateway` writes the profile
 * without a displayName so the onboarding flow can detect "user has
 * not personalized this yet"), and `avatarColor` falls back to a
 * deterministic palette pick from the id. Callers always see
 * populated fields.
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
    const transport =
      parsed.transport === 'local' || parsed.transport === 'iroh' || parsed.transport === 'direct'
        ? parsed.transport
        : undefined;
    return {
      id: parsed.id,
      kind: parsed.kind,
      label: parsed.label,
      displayName,
      avatarColor,
      ...(transport ? { transport } : {}),
      ...(typeof parsed.url === 'string' && parsed.url.length > 0 ? { url: parsed.url } : {}),
      ...(typeof parsed.endpointTicket === 'string' && parsed.endpointTicket.length > 0
        ? { endpointTicket: parsed.endpointTicket }
        : {}),
      ...(typeof parsed.endpointId === 'string' && parsed.endpointId.length > 0
        ? { endpointId: parsed.endpointId }
        : {}),
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
  /**
   * `direct` remote (https/http URL + token). Required for a direct add;
   * omit when adding an `iroh` gateway.
   */
  url?: string;
  /**
   * `iroh` remote (EndpointTicket — EndpointId + relay hint, redeemed from a
   * pairing ticket). Required for an iroh add; omit for direct.
   */
  endpointTicket?: string;
  /** Iroh EndpointId (for display). Optional; carried alongside the ticket. */
  endpointId?: string;
  /** Bearer token. Stored in keychain, never on disk. Empty = unauthenticated. */
  token: string;
  /** Optional friendly name. Defaults to `label` at read time. */
  displayName?: string;
  /** Optional avatar color as `#RRGGBB`. Defaults to a deterministic palette pick. */
  avatarColor?: string;
}

/**
 * Mint a UUID, persist the profile + token, and create the per-gateway
 * dirs. Two transports: `direct` (a URL — the plain-http guardrail rejects
 * cleartext to a public host, #289 decision 6) or `iroh` (an EndpointTicket).
 * We don't probe the gateway here (the UI does its own "Test connection").
 */
export async function addGateway(input: AddGatewayInput): Promise<GatewayProfile> {
  const label = input.label.trim();
  if (!label) throw new GatewayError('invalid_input', 'Gateway label cannot be empty.');
  const url = input.url?.trim();
  const endpointTicket = input.endpointTicket?.trim();
  if (!url && !endpointTicket) {
    throw new GatewayError('invalid_input', 'A gateway needs either a URL or an iroh endpoint.');
  }
  if (url && endpointTicket) {
    throw new GatewayError('invalid_input', 'A gateway is reached by URL or by iroh, not both.');
  }
  const transport: GatewayTransport = endpointTicket ? 'iroh' : 'direct';
  if (url) {
    try {
      assertDirectUrlAllowed(url);
    } catch (err) {
      throw new GatewayError(
        'invalid_input',
        err instanceof TransportGuardError ? err.message : String(err),
      );
    }
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
    transport,
    ...(url ? { url } : {}),
    ...(endpointTicket ? { endpointTicket } : {}),
    ...(input.endpointId ? { endpointId: input.endpointId } : {}),
    createdAt: new Date().toISOString(),
  };
  await fs.mkdir(gatewayDir(id), { recursive: true });
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
 * is fine. (#280 removed "additional local workspaces" — a second space
 * is a second VAULT now, so the only locals are the primordial one.)
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
  // Tear down any live iroh proxy for this gateway before its dir goes.
  const { closeIrohDialer } = await import('./iroh-dialer.js');
  await closeIrohDialer(id);
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
    const info = localGatewayInfo(profile.id);
    return {
      profile,
      url: info?.url ?? '',
      token: info?.token ?? '',
    };
  }
  const token = (await getGatewayToken(profile.id)) ?? '';
  // An iroh gateway has no URL — dial it and stand up a loopback proxy so
  // the HTTP client hits `http://127.0.0.1:<port>` transport-blind (#289).
  if (resolveTransport(profile) === 'iroh' && profile.endpointTicket) {
    try {
      const url = await ensureIrohProxy(profile.id, profile.endpointTicket);
      return { profile, url, token };
    } catch {
      // Dial failure → empty URL; callers surface "unreachable" like any
      // offline gateway, and the switcher badges it.
      return { profile, url: '', token };
    }
  }
  return {
    profile,
    url: profile.url ?? '',
    token,
  };
}

export { GatewayError };
