import type { HealthCopy, OpsState } from "../../kit/components/health-line";
import { memberFacingError } from "../../kit/member-error";
import type { DeviceRow, DeviceTicket } from "../../lib/devices";
import type { VaultRow } from "../../lib/gateway";

export const FULL_ROSTER = 8;

export function memberDeviceError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  return memberFacingError(message).replace(
    /\bvault host\b/giu,
    "home machine"
  );
}

export interface DeviceRowCopy {
  key: string;
  title: string;
  sub: string;
  meta: string;
  off: boolean;
}

export interface DeviceGroup {
  key: string;
  label: string;
  meta: string;
  devices: DeviceRow[];
  rows: DeviceRowCopy[];
}

export function pairedOn(iso: string | undefined): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  return new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
  });
}

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

export function stateWord(device: DeviceRow, other: boolean): string {
  if (device.revoked) return "Revoked";
  if (device.current === true) return "This device";
  if (other) return "Other person";
  return "Fine";
}

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
    meta: String(devices.length),
    rows: devices.map((device) => deviceRowCopy(device, other)),
  };
}

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

export function hasOtherPeople(groups: readonly DeviceGroup[]): boolean {
  if (groups.length > 1) return true;
  return groups.length === 1 && groups[0]?.key !== "yours";
}

export function vaultRowCopy(vault: VaultRow): DeviceRowCopy {
  return {
    key: vault.vaultId,
    meta: "",
    off: false,
    sub: vault.blurb ?? vault.vaultId,
    title: vault.name,
  };
}

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
    errorText:
      "Your vault's home machine has not answered, so this roster may be stale.",
    label,
    loadingText: "Reading the devices paired with this vault.",
  };
}

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

export function isLastDeviceRefusal(error: unknown): boolean {
  return error instanceof Error && /\b409\b/u.test(error.message);
}

export function strandedVaultName(device: DeviceRow): string {
  return device.vaultName ?? device.vaultId;
}
