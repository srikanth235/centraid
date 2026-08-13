// The Devices place, as pure model (issue #765, spec §7).
//
// Everything the screen SAYS is derived here so the copy contract is under
// test without a renderer — the split `screens/home/home-status.ts` and
// `kit/components/health-line.ts` already make. The screen owns pressing,
// this file owns wording, grouping and the five states.
//
// Two honest omissions live in this file rather than in a comment on the
// screen, because they are facts about the DATA, not about the layout:
//
//  1. `DeviceRow` carries no "last seen" (the route's `toDto` never emits
//     `lastUsedAt`), so no row can say `Dormant` and none of them tries. The
//     reference's `seen 11 minutes ago` clause is simply absent rather than
//     rendered as an always-empty phrase.
//  2. There is no recovery plane on this wire at all — no nominated people,
//     no two-of-three. The reference's "Shared recovery" section and its note
//     are therefore not built: a section with invented rows would be the one
//     failure mode this screen cannot afford.

import type { HealthCopy, OpsState } from "../../kit/components/health-line";
import type { DeviceRow, DeviceTicket } from "../../lib/devices";
import type { VaultRow } from "../../lib/gateway";

/** The roster size at which the page reads as `full` rather than `ready` —
 *  the reference's own full-state roster (spec §7: 8 devices). */
export const FULL_ROSTER = 8;

/** What one device says, before the screen decides what pressing it does. */
export interface DeviceRowCopy {
  /** `deviceId` — the revocation handle, and the row's list identity. */
  key: string;
  title: string;
  sub: string;
  meta: string;
  /** A revoked binding: present for attribution, inert. */
  off: boolean;
}

/** One band of the roster. `label`/`meta` feed `SectionBlock` verbatim. */
export interface DeviceGroup {
  key: string;
  label: string;
  meta: string;
  /** The devices themselves, so the screen can wire per-row verbs. */
  devices: DeviceRow[];
  rows: DeviceRowCopy[];
}

/** The day something happened, in the reader's locale ("3 March"). A pairing
 *  is remembered as a date; nothing here is read as an age, because the wire
 *  carries no clock for these rows. */
export function pairedOn(iso: string | undefined): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  return new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
  });
}

/** A time of day, for the one clock this screen does have: a ticket expiry. */
export function expiresAt(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function computePhrase(device: DeviceRow): string {
  if (!device.compute) return "";
  return device.compute.contributeWhileCharging
    ? "contributing compute"
    : "not contributing compute";
}

/** The row's one state word: what this device IS to you right now. */
export function stateWord(device: DeviceRow, other: boolean): string {
  if (device.revoked) return "Revoked";
  if (device.current === true) return "This device";
  if (other) return "Other person";
  return "Fine";
}

/** The row's sub line — whose it is, what it is doing, and since when. */
export function subLine(device: DeviceRow, other: boolean): string {
  return [
    other ? device.ownerLabel : "",
    device.current === true ? "This device" : "",
    computePhrase(device),
    device.platform ?? "",
    device.addedAt ? `paired ${pairedOn(device.addedAt)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function deviceRowCopy(
  device: DeviceRow,
  other: boolean
): DeviceRowCopy {
  return {
    key: device.deviceId,
    meta: stateWord(device, other),
    off: device.revoked,
    sub: subLine(device, other),
    title: device.label,
  };
}

/**
 * Who "you" are on this roster.
 *
 * The phone reads the roster as itself over its own paired tunnel, so the row
 * marked `current` names the caller. When nothing is marked — a roster read
 * through a link that predates the flag — a roster with exactly ONE owner
 * still answers the question, and a roster with several does not: rather than
 * guess, `rosterGroups` then names each band after its owner instead of
 * calling one of them yours.
 */
export function selfOwnerId(devices: readonly DeviceRow[]): string | undefined {
  const current = devices.find((device) => device.current === true);
  if (current) return current.ownerId;
  const owners = new Set(devices.map((device) => device.ownerId));
  return owners.size === 1 ? [...owners][0] : undefined;
}

function groupOf(
  key: string,
  label: string,
  devices: DeviceRow[],
  other: boolean
): DeviceGroup {
  return {
    devices,
    key,
    label,
    // The count is of what the band holds, tombstones included — a revoked
    // binding is still a row a member has to scroll past.
    meta: String(devices.length),
    rows: devices.map((device) => deviceRowCopy(device, other)),
  };
}

/**
 * The roster, split into the bands the page shows.
 *
 * `Yours` first, then everyone else under one `Other people` heading — the
 * reference's split, driven by `ownerId` rather than by a row index, because
 * on a real gateway the caller's own devices are almost all of them.
 */
export function rosterGroups(devices: readonly DeviceRow[]): DeviceGroup[] {
  const self = selfOwnerId(devices);
  if (self === undefined) {
    const owners = [...new Set(devices.map((device) => device.ownerId))];
    return owners.map((ownerId) => {
      const band = devices.filter((device) => device.ownerId === ownerId);
      const label = band[0]?.ownerLabel ?? ownerId;
      return groupOf(ownerId, label, band, true);
    });
  }
  const yours = devices.filter((device) => device.ownerId === self);
  const others = devices.filter((device) => device.ownerId !== self);
  const groups = [groupOf("yours", "Yours", yours, false)];
  if (others.length > 0) {
    groups.push(groupOf("others", "Other people", others, true));
  }
  return groups;
}

/** Does a band of other people's hardware render at all? The note about what
 *  a person on your gateway can reach is published only when it does. */
export function hasOtherPeople(groups: readonly DeviceGroup[]): boolean {
  if (groups.length > 1) return true;
  return groups.length === 1 && groups[0]?.key !== "yours";
}

/** One owned vault, as a fact row. No verb: this screen reads the registry,
 *  and vault administration is the host's command line (`lib/gateway.ts`). */
export function vaultRowCopy(vault: VaultRow): DeviceRowCopy {
  return {
    key: vault.vaultId,
    meta: "",
    off: false,
    sub: vault.blurb ?? vault.vaultId,
    title: vault.name,
  };
}

/**
 * Which of the five states the page is in.
 *
 * `empty` is the reference's own reading of it: a roster whose only live
 * binding is the phone asking. One device is not a list, it is the sentence
 * "only this device is enrolled".
 */
export function devicesState(input: {
  status: "loading" | "ready" | "error";
  devices: readonly DeviceRow[];
}): OpsState {
  if (input.status === "loading") return "loading";
  if (input.status === "error") return "error";
  const live = input.devices.filter((device) => !device.revoked);
  if (live.length <= 1) return "empty";
  return live.length >= FULL_ROSTER ? "full" : "ready";
}

/**
 * The standing sentence, in the reference's shape (`label · detail`) but off
 * live facts only.
 *
 * The one thing that can be PENDING here is a pairing ticket this phone has
 * minted and nobody has redeemed — the gateway serves no inbound "Ana asked
 * to connect" plane to the phone, so that is the request the line reports.
 * It publishes no inline verb: the ticket it is talking about is on the
 * screen already, and "Review it" would scroll to what the member is looking
 * at.
 */
export function devicesHealthCopy(input: {
  devices: readonly DeviceRow[];
  pendingTickets: number;
}): HealthCopy {
  const live = input.devices.filter((device) => !device.revoked);
  const people = new Set(live.map((device) => device.ownerId)).size;
  const pending = input.pendingTickets;
  const label =
    pending > 0
      ? `${pending} ${pending === 1 ? "request is" : "requests are"} pending`
      : `${live.length} ${live.length === 1 ? "device" : "devices"} paired`;
  const detail =
    pending > 0
      ? pending === 1
        ? "A pairing ticket minted here has not been used yet."
        : "Pairing tickets minted here have not been used yet."
      : people > 1
        ? `${people} people, and nothing is waiting to be accepted.`
        : "All yours, and nothing is waiting to be accepted.";
  return {
    detail,
    emptyText: "Only this device is enrolled.",
    errorText: "The gateway has not answered, so this roster may be stale.",
    label,
    loadingText: "Reading the devices paired to this gateway.",
  };
}

/** What the minted ticket's panel says beside the token itself. */
export function ticketFacts(
  ticket: DeviceTicket
): Array<{ key: string; label: string; value: string }> {
  const vaults = ticket.vaults.length
    ? ticket.vaults.map((vault) => vault.vaultName ?? vault.vaultId).join(", ")
    : (ticket.vaultName ?? ticket.vaultId);
  return [
    { key: "for", label: "for", value: ticket.ownerLabel },
    { key: "vaults", label: "reaches", value: vaults },
    { key: "expires", label: "expires", value: expiresAt(ticket.expiresAt) },
  ];
}

/**
 * Did the gateway refuse this revocation because it would strand a vault?
 *
 * The gateway answers 409 for exactly that, and `fetchJson` raises a
 * `GatewayError` whose message carries the status and NOT the body (mobile's
 * HTTP core never surfaces a response body — see `lib/devices.ts`). So the
 * status is all there is to read, and the vault name the member must echo
 * back has to come from the device row rather than from the refusal. Any
 * other conflict on this route would be read the same way; the confirm that
 * follows asks for a name the member has to type, so a misread costs a
 * correct-looking prompt, never an unintended revocation.
 */
export function isLastDeviceRefusal(error: unknown): boolean {
  return error instanceof Error && /\b409\b/u.test(error.message);
}

/** The vault whose name the member must type to revoke this device. */
export function strandedVaultName(device: DeviceRow): string {
  return device.vaultName ?? device.vaultId;
}
