export const GATEWAY_WRITE_FAULT_POINTS = [
  "journal-after-append",
  "blob-after-stage",
  "wal-before-checkpoint",
  "automation-after-claim",
] as const;

export type GatewayWriteFaultPoint =
  (typeof GATEWAY_WRITE_FAULT_POINTS)[number];
