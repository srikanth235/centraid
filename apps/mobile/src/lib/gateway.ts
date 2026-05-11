// Mobile gateway client. Talks to the openclaw-plugin HTTP surface on the
// user's desktop gateway over the LAN. Mirrors the subset of routes from
// @centraid/agent-harness's gateway-client that mobile needs (list apps,
// build live-app URLs). Gateway URL comes from Settings — no token yet.

import { apps as BUILTIN_APPS, palette } from '@centraid/design-tokens';
import type { AppMetaResolved, ColorKey, IconName } from '@centraid/design-tokens';
import { Store } from '../storage';

export const SETTINGS_KEY = 'settings.gatewayUrl';

/**
 * Subset of the gateway's registry row that mobile cares about. Mirrors the
 * shape returned by `GET /centraid/_apps` (see agent-harness gateway-client).
 */
export interface AppRegistryRow {
  id: string;
  path: string;
  mode: 'uploaded' | 'path';
  registeredAt: string;
  crons: string[];
  cronStatus: Record<string, unknown>;
}

export class GatewayError extends Error {
  constructor(
    public readonly kind: 'no_url' | 'unreachable' | 'bad_response',
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

/** Build a URL under the configured gateway. Throws if not yet configured. */
function url(pathname: string): string {
  const base = normalizeBase(getGatewayUrl());
  if (!base) {
    throw new GatewayError('no_url', 'Gateway URL not configured. Open Settings to add one.');
  }
  return `${base}${pathname}`;
}

export function appLiveUrl(appId: string): string {
  return url(`/centraid/${encodeURIComponent(appId)}/`);
}

async function fetchOrThrow(href: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(href, init);
  } catch (err) {
    throw new GatewayError(
      'unreachable',
      `Could not reach gateway at ${getGatewayUrl()}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export async function listApps(): Promise<AppRegistryRow[]> {
  const res = await fetchOrThrow(url('/centraid/_apps'), { method: 'GET' });
  if (!res.ok) {
    throw new GatewayError('bad_response', `Gateway returned HTTP ${res.status}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text) as AppRegistryRow[];
  } catch {
    throw new GatewayError('bad_response', `Gateway returned non-JSON: ${text.slice(0, 120)}`);
  }
}

// --- Display-metadata fallbacks ---
//
// The registry row only carries id + path + cron state — no name, color,
// or icon. Mobile derives display metadata from id:
//   1. If the id matches a built-in template, reuse that AppMeta.
//   2. Else: title-case the id, hash it into the palette, fall back to a
//      generic icon. Mobile is read-only here; the desktop owns naming.

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

/** Map a registry row into a tile-renderable AppMetaResolved. */
export function resolveAppMeta(row: AppRegistryRow): AppMetaResolved {
  const hit = BUILTIN_BY_ID.get(row.id);
  if (hit) return hit;

  const colorKey = hashIdToColor(row.id);
  const iconKey: IconName = 'Sparkle';
  return {
    color: palette[colorKey],
    colorKey,
    desc: '',
    iconKey,
    id: row.id,
    name: titleCaseFromId(row.id),
  };
}
