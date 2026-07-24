// Mobile gateway client (issue #263). Base-URL resolution order:
//   (a) the paired tunnel — a localhost proxy that forwards every request
//       over iroh to the desktop, which attaches the bearer on its side;
//   (b) the manual gateway URL from Settings → Advanced — a developer
//       fallback for simulators pointing at a token-less dev gateway. The
//       token here is only used for RN-side API fetches (listing apps,
//       approvals); WebView loads against an authed gateway need the tunnel.

import { apps as BUILTIN_APPS, icons, palette } from '@centraid/design-tokens';
import type { AppMetaResolved, ColorKey, IconName } from '@centraid/design-tokens';
import { ensureTunnelStarted } from './phone-link';
import { getSecure, hydrateSecure, setSecure } from './secure-storage';
import { getActiveVaultId } from './spaces';
import { Store } from '../storage';

export const SETTINGS_KEY = 'settings.gatewayUrl';
export const SETTINGS_TOKEN_KEY = 'settings.gatewayToken';

/**
 * One row of `GET /centraid/_apps` — the worktree-store listing
 * (see packages/gateway makeAppsStoreRouteHandler / listAppsWithMeta).
 * `iconKey`/`colorKey` are optional manifest extras; rows without them
 * fall back to derived display metadata.
 */
export interface AppRegistryRow {
  id: string;
  name?: string;
  description?: string;
  kind?: 'app' | 'automation';
  hasIndex: boolean;
  iconKey?: string;
  colorKey?: string;
}

/** One parked vault invocation (VaultPlane listParked → ParkedSummary). */
export interface ParkedInvocation {
  invocationId: string;
  command: string;
  parkedAt: string;
  /** Identity kind of the caller, e.g. 'app' | 'agent' | 'owner-device'. */
  callerKind: string;
  /** Display name of the caller (consent.app.name for apps), or null. */
  caller: string | null;
  input: Record<string, unknown>;
}

export class GatewayError extends Error {
  constructor(
    public readonly kind: 'no_gateway' | 'unreachable' | 'bad_response',
    message: string,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

/** Strip a trailing `/` so we can confidently concatenate paths. */
function normalizeBase(raw: string): string {
  return raw.replace(/\/+$/, '');
}

export async function hydrateGatewayUrl(): Promise<string> {
  return Store.hydrate<string>(SETTINGS_KEY, '');
}

export function setGatewayUrl(value: string): void {
  Store.set<string>(SETTINGS_KEY, value.trim());
}

export function getGatewayToken(): string {
  return getSecure(SETTINGS_TOKEN_KEY, '');
}

export async function hydrateGatewayToken(): Promise<string> {
  return hydrateSecure(SETTINGS_TOKEN_KEY, '');
}

export function setGatewayToken(value: string): void {
  void setSecure(SETTINGS_TOKEN_KEY, value.trim());
}

/**
 * Authorization header for RN-side API fetches in manual-URL dev mode.
 * Harmless over the tunnel — the desktop overrides `authorization` before
 * forwarding to its loopback gateway.
 */
export function authHeader(): Record<string, string> {
  const token = getGatewayToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * The `x-centraid-vault` header addressing the active Space's vault (issue #289
 * addressing model). Every RN-side gateway fetch carries it so the whole app —
 * app grid, Settings → Space, approvals — follows whichever vault the Spaces
 * switcher has active, instead of floating to the gateway's implied default.
 * '' (no active vault, e.g. fresh manual-URL dev) sends no header, preserving
 * the old "let the gateway pick" behaviour. The replica sends its own copy of
 * this header (ReplicaProvider) keyed on the same active Space.
 */
export function vaultHeader(): Record<string, string> {
  const vaultId = getActiveVaultId();
  return vaultId ? { 'x-centraid-vault': vaultId } : {};
}

/** The RN-fetch header set every authed gateway call needs: auth + active vault. */
export function apiHeaders(extra?: Record<string, string>): Record<string, string> {
  return { ...authHeader(), ...vaultHeader(), ...extra };
}

/**
 * Resolve the base URL for every gateway request: paired tunnel first,
 * manual URL second. `undefined` when neither is configured; throws
 * PhoneLinkError when the device is paired but the tunnel fails to start.
 */
export async function resolveGatewayBase(): Promise<string | undefined> {
  const tunnel = await ensureTunnelStarted();
  if (tunnel) return tunnel.baseUrl;
  const manual = await hydrateGatewayUrl();
  if (!manual) return undefined;
  // Warm the token cache before the caller builds `authHeader()`. That helper is
  // sync (cache-only), and the Settings screen is otherwise the ONLY place that
  // hydrates the token — so on a cold start into manual-URL dev mode every authed
  // fetch would go out bearer-less and 401 until Settings was opened once. The
  // tunnel path skips this: the desktop attaches its own auth on forward.
  await hydrateGatewayToken();
  return normalizeBase(manual);
}

export async function requireGatewayBase(): Promise<string> {
  const base = await resolveGatewayBase();
  if (!base) {
    throw new GatewayError(
      'no_gateway',
      'Not connected to a desktop. Pair with your desktop in Settings.',
    );
  }
  return base;
}

export function appLiveUrl(base: string, appId: string): string {
  return `${base}/centraid/${encodeURIComponent(appId)}/`;
}

async function fetchOrThrow(href: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(href, init);
  } catch (err) {
    throw new GatewayError(
      'unreachable',
      `Could not reach the gateway: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function fetchJson<T>(href: string, init?: RequestInit): Promise<T> {
  const res = await fetchOrThrow(href, init);
  if (!res.ok) {
    throw new GatewayError('bad_response', `Gateway returned HTTP ${res.status}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GatewayError('bad_response', `Gateway returned non-JSON: ${text.slice(0, 120)}`);
  }
}

/**
 * The full worktree-store listing — apps *and* automations, published or not.
 * The Home launcher reads this once per load and splits it locally: openable
 * apps feed the grid, automation rows feed the attention line's count. Keeping
 * the single fetch here (rather than one call per view) halves the tunnel
 * round-trips on every focus/refresh.
 */
export async function listAppRegistry(): Promise<AppRegistryRow[]> {
  const base = await requireGatewayBase();
  return fetchJson<AppRegistryRow[]>(`${base}/centraid/_apps`, {
    headers: apiHeaders(),
    method: 'GET',
  });
}

/**
 * An openable app: has a published `index.html` and is not an automation.
 * Mobile is a viewer for published UIs, so unpublished/automation rows never
 * become launcher tiles. Exported so the split rule lives in exactly one place.
 */
export function isOpenableApp(row: AppRegistryRow): boolean {
  return row.hasIndex !== false && row.kind !== 'automation';
}

/** Parked vault invocations awaiting the owner's confirmation. */
export async function listParked(): Promise<ParkedInvocation[]> {
  const base = await requireGatewayBase();
  const body = await fetchJson<{ parked: ParkedInvocation[] }>(`${base}/centraid/_vault/parked`, {
    headers: apiHeaders(),
    method: 'GET',
  });
  return body.parked;
}

/** Approve or deny one parked invocation. */
export async function confirmParked(invocationId: string, approve: boolean): Promise<void> {
  const base = await requireGatewayBase();
  await fetchJson<unknown>(`${base}/centraid/_vault/parked/${encodeURIComponent(invocationId)}`, {
    body: JSON.stringify({ approve }),
    headers: apiHeaders({ 'content-type': 'application/json' }),
    method: 'POST',
  });
}

/**
 * One vault of the owner's registry — a "space" in the UI. Presentation
 * (`color`/`icon`/`blurb`) lives in `core_vault.settings_json` (#280: profiles
 * are vaults). Mirrors `VaultListEntry` in packages/client gateway-client-vault
 * ts — `color` is a raw hex string, `icon` a design-tokens IconName key.
 */
export interface VaultRow {
  vaultId: string;
  name: string;
  ownerPartyId: string;
  color?: string;
  icon?: string;
  blurb?: string;
}

/**
 * The owner's vault registry from `GET /centraid/_vault/vaults` (returns
 * `{ vaults }`). `undefined` when the gateway mounts no vault plane (route
 * 404s) — a valid deployment, so callers render a "no space" state, not an
 * error. There is no server-side active flag (#289): the active vault is a
 * device-local pointer (see lib/spaces.ts), and the Spaces switcher reads this
 * list to offer the vaults this device may address. Deliberately header-free
 * (no `vaultHeader()`): the switcher's own data source must not depend on the
 * active vault being valid, and an unknown `x-centraid-vault` would 404 here.
 */
export async function listVaults(): Promise<VaultRow[] | undefined> {
  const base = await requireGatewayBase();
  const res = await fetchOrThrow(`${base}/centraid/_vault/vaults`, {
    headers: authHeader(),
    method: 'GET',
  });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new GatewayError('bad_response', `Gateway returned HTTP ${res.status}`);
  const body = (await res.json()) as { vaults: VaultRow[] };
  return body.vaults;
}

/**
 * Rename a vault and/or update its presentation via `PATCH
 * /centraid/_vault/vaults/:id` (only supplied fields are written). Returns the
 * updated row. The vault is named by URL path, so this is header-free like
 * `listVaults` — no `vaultHeader()`. Vault create/delete have NO client HTTP
 * surface by design (#289): the gateway answers 405 and points at
 * `centraid-gateway vault create|delete` on the host. The mobile "Spaces"
 * feature (lib/spaces.ts) adds/switches/forgets device-local (gateway, vault)
 * tuples — it never creates or destroys a vault.
 */
export async function updateVault(
  vaultId: string,
  patch: { name?: string; color?: string; icon?: string; blurb?: string },
): Promise<VaultRow> {
  const base = await requireGatewayBase();
  return fetchJson<VaultRow>(`${base}/centraid/_vault/vaults/${encodeURIComponent(vaultId)}`, {
    body: JSON.stringify(patch),
    headers: { 'content-type': 'application/json', ...authHeader() },
    method: 'PATCH',
  });
}

// --- Display metadata ---
//
// Prefer the row's real `name`/`description`/`iconKey`/`colorKey` from the
// listing. Fall back per-field: built-in template metadata for known ids,
// then title-cased id + palette hash + generic icon.

const BUILTIN_BY_ID = new Map<string, AppMetaResolved>(BUILTIN_APPS.map((a) => [a.id, a]));

const COLOR_KEYS: readonly ColorKey[] = [
  'violet',
  'rose',
  'amber',
  'teal',
  'forest',
  'indigo',
  'ochre',
  'slate',
];

function hashIdToColor(id: string): ColorKey {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  const idx = Math.abs(h) % COLOR_KEYS.length;
  const key = COLOR_KEYS[idx] ?? 'violet';
  return key;
}

function titleCaseFromId(id: string): string {
  return id
    .replace(/[-_]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(' ');
}

function asIconName(value: string | undefined): IconName | undefined {
  return value !== undefined && value in icons ? (value as IconName) : undefined;
}

function asColorKey(value: string | undefined): ColorKey | undefined {
  return value !== undefined && value in palette ? (value as ColorKey) : undefined;
}

/** Map a registry row into a tile-renderable AppMetaResolved. */
export function resolveAppMeta(
  row: Pick<AppRegistryRow, 'id' | 'name' | 'description' | 'iconKey' | 'colorKey'>,
): AppMetaResolved {
  const builtin = BUILTIN_BY_ID.get(row.id);
  const iconKey = asIconName(row.iconKey) ?? builtin?.iconKey ?? 'Sparkle';
  const colorKey = asColorKey(row.colorKey) ?? builtin?.colorKey ?? hashIdToColor(row.id);
  return {
    color: palette[colorKey],
    colorKey,
    desc: row.description ?? builtin?.desc ?? '',
    iconKey,
    id: row.id,
    name: row.name ?? builtin?.name ?? titleCaseFromId(row.id),
  };
}
