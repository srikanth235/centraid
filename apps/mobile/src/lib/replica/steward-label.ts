// Mirrors the gateway's `commonsStewardDeviceLabel`
// (`packages/vault/src/gateway/gateway.ts`) so the phone reaches the same
// label before any gateway reply. The rule is the gateway's, not invented
// here; its shared home is `packages/blueprints/apps/_shared/pending-overlay.ts`,
// beside `pendingOverlayCopy`, and this copy is a known duplication (#883).

export const UNNAMED_STEWARD_LABEL = "the commons steward's device";

/** Present means the member does NOT steward this vault, so a write may wait. */
export interface MountedSteward {
  displayName?: string;
}

/** Whitespace is collapsed first: a name with a line break is still one line. */
export function stewardDeviceLabel(displayName?: string): string {
  const label = (displayName ?? "").trim().replace(/\s+/gu, " ");
  if (!label) return UNNAMED_STEWARD_LABEL;
  const possessive = /['’]s$/iu.test(label)
    ? label
    : /['’]$/u.test(label)
      ? `${label}s`
      : `${label}'s`;
  return `${possessive} device`;
}
