export const UNNAMED_STEWARD_LABEL = "the commons steward's device";

export interface MountedSteward {
  displayName?: string;
}

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
