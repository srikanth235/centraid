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

export function getGatewayUrl(): string {
  return Store.get<string>(SETTINGS_KEY, '');
}

export async function hydrateGatewayUrl(): Promise<string> {
  return Store.hydrate<string>(SETTINGS_KEY, '');
}

export function setGatewayUrl(value: string): void {
  Store.set<string>(SETTINGS_KEY, value.trim());
}

export function getGatewayToken(): string {
  return Store.get<string>(SETTINGS_TOKEN_KEY, '');
}

export async function hydrateGatewayToken(): Promise<string> {
  return Store.hydrate<string>(SETTINGS_TOKEN_KEY, '');
}

export function setGatewayToken(value: string): void {
  Store.set<string>(SETTINGS_TOKEN_KEY, value.trim());
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
 * Resolve the base URL for every gateway request: paired tunnel first,
 * manual URL second. `undefined` when neither is configured; throws
 * PhoneLinkError when the device is paired but the tunnel fails to start.
 */
export async function resolveGatewayBase(): Promise<string | undefined> {
  const tunnel = await ensureTunnelStarted();
  if (tunnel) return tunnel.baseUrl;
  const manual = await hydrateGatewayUrl();
  return manual ? normalizeBase(manual) : undefined;
}

async function requireGatewayBase(): Promise<string> {
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

async function fetchJson<T>(href: string, init?: RequestInit): Promise<T> {
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
 * List openable apps. Rows without a published `index.html` and automation
 * rows are filtered out — mobile is a viewer for published UIs.
 */
export async function listApps(): Promise<AppRegistryRow[]> {
  const base = await requireGatewayBase();
  const rows = await fetchJson<AppRegistryRow[]>(`${base}/centraid/_apps`, {
    headers: authHeader(),
    method: 'GET',
  });
  return rows.filter((row) => row.hasIndex !== false && row.kind !== 'automation');
}

/** Parked vault invocations awaiting the owner's confirmation. */
export async function listParked(): Promise<ParkedInvocation[]> {
  const base = await requireGatewayBase();
  const body = await fetchJson<{ parked: ParkedInvocation[] }>(`${base}/centraid/_vault/parked`, {
    headers: authHeader(),
    method: 'GET',
  });
  return body.parked;
}

/** Approve or deny one parked invocation. */
export async function confirmParked(invocationId: string, approve: boolean): Promise<void> {
  const base = await requireGatewayBase();
  await fetchJson<unknown>(`${base}/centraid/_vault/parked/${encodeURIComponent(invocationId)}`, {
    body: JSON.stringify({ approve }),
    headers: { 'content-type': 'application/json', ...authHeader() },
    method: 'POST',
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
