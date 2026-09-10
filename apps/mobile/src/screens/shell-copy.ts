/**
 * WHAT THE SHELL SAYS (#1015, S11 + S14 — shell/findings 6, 13, 17, 18, 22).
 *
 * Two rules, and this file is where both are checkable:
 *
 * ONE NOUN PER DESTINATION. The audit found the Alerts place wearing four
 * names at once — "Alerts" in the band, "Notifications" in More, a clipped
 * "Notificati…" in its own bar, and a Settings section headed NOTIFICATIONS
 * over a row that said "Decisions and updates" — while VoiceOver read a fifth
 * thing, because the band spoke `name` and painted `short`. A member cannot
 * learn a place they are never told the name of twice.
 *
 * NO ENGINE VOCABULARY, AND NO PAYLOADS. Six shell surfaces shipped the
 * machinery's own words to the member: a section headed "Advanced
 * (developer)", a tunnel row reading "Connected (port 8787)", a pairing
 * failure printed as `error.message`, an enrichment row named by its worker id.
 * A raw reason is a fact about the program, not about the member's vault. The
 * shell has ONE error noun per surface and ONE retry word (`RETRY_ACTION`,
 * "Try again"), and an exception is captured for the log rather than shown.
 *
 * Tables, not switch statements in `.tsx`: `shell-copy.test.ts` sweeps every
 * table here for sentence case and for the noun, which it cannot do to a
 * `switch` buried in a render.
 */

import type { TunnelStatus } from "../lib/phone-link";

/** The desktop link, in the member's words — never the port, never the reason. */
export const DESKTOP_LINK_STATUS = {
  running: "Connected",
  starting: "Connecting…",
  error: "Not connected — this phone could not reach your desktop",
  stopped: "Not connected",
} as const satisfies Record<TunnelStatus["state"], string>;

export const DESKTOP_LINK_CHECKING = "Checking…";

/** `status.error` and `status.port` are diagnostics; neither is copy. */
export function desktopLinkStatus(status: TunnelStatus | undefined): string {
  return status ? DESKTOP_LINK_STATUS[status.state] : DESKTOP_LINK_CHECKING;
}

/**
 * One error noun per shell surface. Each is a whole sentence about the
 * member's vault, and each is followed by `RETRY_ACTION` where a retry exists.
 */
export const SHELL_ERROR = {
  access: "Your standing permissions could not be read",
  alerts: "Your alerts could not be loaded",
  connectors: "Your connectors could not be loaded",
  copies: "The copies of your vault could not be read",
  desktopLink: "This phone could not link to your desktop",
  enrichment: "Your enrichment settings could not be read",
  scan: "This code could not be read",
  vault: "Your vault's contents could not be read",
  vaultSettings: "Your vault settings could not be saved",
} as const;

/** The shell's own destinations, one noun each; `places.ts` holds the rest. */
export const SHELL_TITLES = {
  alerts: "Alerts",
  backupHealth: "Backup health",
  onThisPhone: "On this phone",
  settings: "Settings",
  sharing: "Sharing",
} as const;
