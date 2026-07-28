/*
 * Ownership words for the three roles, plus the human reading of the
 * gateway's pairing refusals (issue #599 Decision 10 / Decision 15).
 *
 * `admin`/`write`/`read` is the wire lattice. The owner never sees those
 * words: a household reasons in Owner / Member / Viewer, and the surfaces
 * that show them (DevicesCard, DevicePairPanel) share this one table so the
 * card and the panel can never drift apart. "user" and "account" are
 * forbidden synonyms — the noun is a *person*.
 *
 * `revoked` is a tombstone state a device is put into, never a role handed
 * out, which is why it is absent from the presets but present in `roleLabel`.
 */

import type { GatewayDeviceRole } from '../../gateway-client.js';

export interface RolePreset {
  role: GatewayDeviceRole;
  label: string;
  hint: string;
}

/*
 * Ordered least → most authority, so the picker reads as a ladder. `write`
 * (Member) is the default because a ticket LEAVES this machine — whatever
 * redeems it lands at the role baked in, and defaulting to Owner would let a
 * casually paired phone mint further tickets and revoke this very device.
 */
export const ROLE_PRESETS: readonly RolePreset[] = [
  {
    role: 'read',
    label: 'Viewer',
    hint: 'Can see this space. Cannot change anything.',
  },
  {
    role: 'write',
    label: 'Member',
    hint: 'Can see and change this space. The usual choice.',
  },
  {
    role: 'admin',
    label: 'Owner',
    hint: 'Everything, plus pairing new devices and removing people — including you.',
  },
];

/** The default a fresh grant row starts at. */
export const DEFAULT_ROLE: GatewayDeviceRole = 'write';

/** The ownership word for a role, including the `revoked` tombstone. */
export function roleLabel(role: GatewayDeviceRole | 'revoked'): string {
  if (role === 'revoked') return 'Revoked';
  return ROLE_PRESETS.find((preset) => preset.role === role)?.label ?? role;
}

/*
 * `readJson` folds the gateway's JSON error body into the thrown message, so
 * the machine-readable code arrives embedded rather than as a field. Read it
 * back out here rather than teach every screen to parse HTTP bodies.
 */
const PAIR_ERRORS: readonly (readonly [string, string])[] = [
  [
    'role_above_own',
    'You can only pair a device for yourself at the access you already have. Ask an owner of that space to pair it for you.',
  ],
  [
    'not_admin',
    'Pairing a device for someone else needs you to be an Owner of every space you are granting.',
  ],
  ['ambiguous_member', 'Pick an existing person or add a new one — not both.'],
  ['invalid_member_label', 'Give the new person a name.'],
  ['member_not_found', 'That person is no longer in the household. Reload and try again.'],
  ['invalid_grants', 'Each space needs a role. Remove any blank row and try again.'],
  ['grants_required', 'Choose at least one space this device may reach.'],
  ['no_iroh_endpoint', 'The gateway has no network identity yet. Start it and try again.'],
  ['vault_required', 'Choose at least one space this device may reach.'],
  ['device_identity_required', 'This device is not allowed to pair others.'],
];

/** Turn a mint failure into something a person can act on. */
export function pairErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  for (const [code, message] of PAIR_ERRORS) {
    if (raw.includes(code)) return message;
  }
  return raw;
}

/*
 * The gateway refuses to strand a space with no owner: removing the last live
 * owner device — or the last owner person — 409s until the caller echoes that
 * space's name back in `confirmLastAdmin`. It names the space inside the
 * refusal (JSON-quoted), so the surface can escalate its confirm in place
 * instead of making the owner retype anything.
 */
const LAST_ADMIN_CODE = 'last_admin_confirmation_required';
const LAST_ADMIN_SPACE = /(?:type|member of)\s+\\?"(?<space>[^"\\]+)\\?"/u;

/** The space that would lose its last owner, or `undefined` for other errors. */
export function lastAdminSpace(err: unknown): string | undefined {
  const raw = err instanceof Error ? err.message : String(err);
  if (!raw.includes(LAST_ADMIN_CODE)) return undefined;
  return LAST_ADMIN_SPACE.exec(raw)?.[1];
}
