import { IDENTITY_COLORS } from "@centraid/design";

/**
 * Gateway profile registry — pure core (issue #109 / #545 C1).
 *
 * Avatar palette, profile shape validation, read-time defaults, and list sort
 * are side-effect-free so unit tests cover them without mocking fs / keychain.
 * I/O and Electron wiring stay in `gateway-store.ts`.
 */

export type GatewayKind = "local" | "remote";

export interface GatewayProfileShape {
  readonly id: string;
  readonly kind: GatewayKind;
  readonly label: string;
  readonly displayName?: string;
  readonly avatarColor?: string;
  readonly endpointId?: string;
  /** Refreshable address cache; never connection identity. */
  readonly relayHint?: string;
  readonly rememberDevice?: boolean;
  readonly createdAt: string;
}

/**
 * 8-color avatar palette. Picked for AA contrast against the dark sidebar
 * background and for being visually distinct from each other at 24×24px.
 * The order matters — `defaultAvatarColor` hashes id into this array.
 */
export const AVATAR_PALETTE: readonly string[] = IDENTITY_COLORS;

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
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/u.test(value);
}

export const ENDPOINT_ID_RE = /^[0-9a-f]{64}$/u;

/**
 * A connection identity is either the primordial local gateway or a real
 * 32-byte iroh public key rendered as its 64-character EndpointId.
 */
export function isValidGatewayId(id: string): boolean {
  return id === "local" || ENDPOINT_ID_RE.test(id);
}

/**
 * Normalize a raw `connections.json` row into a populated profile, or
 * `undefined` when required fields are missing/wrong. Applies read-time
 * defaults for `displayName` and `avatarColor`.
 */
export function normalizeProfile(
  id: string,
  parsed: Partial<GatewayProfileShape> | null | undefined
): GatewayProfileShape | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  if (parsed.id !== id) return undefined;
  if (parsed.kind !== "local" && parsed.kind !== "remote") return undefined;
  if (!isValidGatewayId(parsed.id)) return undefined;
  if (typeof parsed.label !== "string" || parsed.label.length === 0)
    return undefined;
  if (typeof parsed.createdAt !== "string") return undefined;
  const displayName =
    typeof parsed.displayName === "string" && parsed.displayName.length > 0
      ? parsed.displayName
      : parsed.label;
  const avatarColor = isValidAvatarColor(parsed.avatarColor)
    ? parsed.avatarColor
    : defaultAvatarColor(parsed.id);
  if (
    parsed.kind === "remote" &&
    (typeof parsed.endpointId !== "string" ||
      parsed.endpointId.length === 0 ||
      parsed.id !== parsed.endpointId)
  ) {
    return undefined;
  }
  return {
    id: parsed.id,
    kind: parsed.kind,
    label: parsed.label,
    displayName,
    avatarColor,
    ...(typeof parsed.endpointId === "string" && parsed.endpointId.length > 0
      ? { endpointId: parsed.endpointId }
      : {}),
    ...(typeof parsed.relayHint === "string" && parsed.relayHint.length > 0
      ? { relayHint: parsed.relayHint }
      : {}),
    rememberDevice: parsed.rememberDevice === true,
    createdAt: parsed.createdAt,
  };
}

/**
 * Stable list order: local first, then remotes by creation time (oldest first).
 * Mutates nothing — returns a new array.
 */
export function sortGatewayProfiles<
  T extends { id: string; createdAt: string },
>(profiles: readonly T[], localId: string): T[] {
  return [...profiles].sort((a, b) => {
    if (a.id === localId) return -1;
    if (b.id === localId) return 1;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

/** Pure field checks for addGateway before any I/O. */
export type AddGatewayFieldError =
  | { ok: false; code: "invalid_input"; message: string }
  | {
      ok: true;
      label: string;
      endpointId: string;
      relayHint?: string;
      displayName: string;
    };

export function validateAddGatewayFields(input: {
  label: string;
  endpointId: string;
  relayHint?: string;
  displayName?: string;
}): AddGatewayFieldError {
  const label = input.label.trim();
  if (!label)
    return {
      ok: false,
      code: "invalid_input",
      message: "Gateway label cannot be empty.",
    };
  const endpointId = input.endpointId.trim();
  if (!endpointId || !isValidGatewayId(endpointId)) {
    return {
      ok: false,
      code: "invalid_input",
      message: "A gateway needs a valid iroh EndpointId.",
    };
  }
  const relayHint = input.relayHint?.trim();
  const displayName = input.displayName?.trim() || label;
  return {
    ok: true,
    label,
    endpointId,
    ...(relayHint ? { relayHint } : {}),
    displayName,
  };
}
