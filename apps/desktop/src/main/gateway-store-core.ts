/**
 * Gateway profile registry — pure core (issue #109 / #545 C1).
 *
 * Avatar palette, profile shape validation, read-time defaults, and list sort
 * are side-effect-free so unit tests cover them without mocking fs / keychain.
 * I/O and Electron wiring stay in `gateway-store.ts`.
 */

import type { GatewayTransport } from './transport.js';

export type GatewayKind = 'local' | 'remote';

export interface GatewayProfileShape {
  readonly id: string;
  readonly kind: GatewayKind;
  readonly label: string;
  readonly displayName?: string;
  readonly avatarColor?: string;
  readonly transport?: GatewayTransport;
  readonly url?: string;
  readonly endpointTicket?: string;
  readonly endpointId?: string;
  readonly rememberDevice?: boolean;
  readonly ssh?: { destination: string; dataDir?: string; remoteCli?: string };
  readonly createdAt: string;
}

/**
 * 8-color avatar palette. Picked for AA contrast against the dark sidebar
 * background and for being visually distinct from each other at 24×24px.
 * The order matters — `defaultAvatarColor` hashes id into this array.
 */
export const AVATAR_PALETTE: readonly string[] = [
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
export function isValidAvatarColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

/** Shape-validate a persisted `ssh` block (issue #382) at read time —
 *  corrupt/malformed JSON degrades to "no ssh block" rather than throwing. */
export function isValidSshBlock(
  value: unknown,
): value is { destination: string; dataDir?: string; remoteCli?: string } {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.destination !== 'string' || v.destination.length === 0) return false;
  if (v.dataDir !== undefined && typeof v.dataDir !== 'string') return false;
  if (v.remoteCli !== undefined && typeof v.remoteCli !== 'string') return false;
  return true;
}

export const GATEWAY_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/i;

/** True when a gateway id is a well-formed slug (not the content of a path). */
export function isValidGatewayId(id: string): boolean {
  return GATEWAY_ID_RE.test(id);
}

/**
 * Normalize a raw `profile.json` object into a populated profile, or
 * `undefined` when required fields are missing/wrong. Applies read-time
 * defaults for `displayName` and `avatarColor`.
 */
export function normalizeProfile(
  id: string,
  parsed: Partial<GatewayProfileShape> | null | undefined,
): GatewayProfileShape | undefined {
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
  const ssh = isValidSshBlock(parsed.ssh) ? parsed.ssh : undefined;
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
    rememberDevice: parsed.rememberDevice === true,
    ...(ssh ? { ssh } : {}),
    createdAt: parsed.createdAt,
  };
}

/**
 * Stable list order: local first, then remotes by creation time (oldest first).
 * Mutates nothing — returns a new array.
 */
export function sortGatewayProfiles<T extends { id: string; createdAt: string }>(
  profiles: readonly T[],
  localId: string,
): T[] {
  return [...profiles].sort((a, b) => {
    if (a.id === localId) return -1;
    if (b.id === localId) return 1;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

/** Pure field checks for addGateway before any I/O. */
export type AddGatewayFieldError =
  | { ok: false; code: 'invalid_input'; message: string }
  | {
      ok: true;
      label: string;
      url?: string;
      endpointTicket?: string;
      transport: 'iroh' | 'direct';
      displayName: string;
    };

export function validateAddGatewayFields(input: {
  label: string;
  url?: string;
  endpointTicket?: string;
  displayName?: string;
}): AddGatewayFieldError {
  const label = input.label.trim();
  if (!label)
    return { ok: false, code: 'invalid_input', message: 'Gateway label cannot be empty.' };
  const url = input.url?.trim();
  const endpointTicket = input.endpointTicket?.trim();
  if (!url && !endpointTicket) {
    return {
      ok: false,
      code: 'invalid_input',
      message: 'A gateway needs either a URL or an iroh endpoint.',
    };
  }
  if (url && endpointTicket) {
    return {
      ok: false,
      code: 'invalid_input',
      message: 'A gateway is reached by URL or by iroh, not both.',
    };
  }
  const transport: 'iroh' | 'direct' = endpointTicket ? 'iroh' : 'direct';
  const displayName = input.displayName?.trim() || label;
  return {
    ok: true,
    label,
    ...(url ? { url } : {}),
    ...(endpointTicket ? { endpointTicket } : {}),
    transport,
    displayName,
  };
}
