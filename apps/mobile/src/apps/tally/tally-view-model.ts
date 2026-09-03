import { contribSections } from "@centraid/blueprints/apps/tally/contrib-model";
import type {
  ContribDoors,
  ContribSections,
  Intent,
} from "@centraid/blueprints/apps/tally/contrib-model";
import { allSettled } from "@centraid/blueprints/apps/tally/format";
import { windowEnd } from "@centraid/blueprints/apps/tally/view-copy";

import { windowFootNoTotal } from "./tally-seat-copy";

export type TallyScreenState =
  | "loading"
  | "denied"
  | "conflict"
  | "parked"
  | "offline"
  | "pending"
  | "stale"
  | "dayone"
  | "settled"
  | "ready";

export interface TallyStateInput {
  loaded: boolean;
  denied: boolean;
  online: boolean;
  pending: number;
  conflicted: boolean;
  parked: boolean;
  rows: number;
  stale: boolean;
  nets?: readonly number[];
}

export function tallyScreenState(input: TallyStateInput): TallyScreenState {
  if (input.denied) return "denied";
  if (!input.loaded) return "loading";
  if (input.conflicted) return "conflict";
  if (input.parked) return "parked";
  if (!input.online) return "offline";
  if (input.pending > 0) return "pending";
  if (input.stale) return "stale";
  if (input.rows === 0) return "dayone";
  if (
    input.nets !== undefined &&
    input.nets.length > 0 &&
    allSettled(input.nets)
  )
    return "settled";
  return "ready";
}

export function tallyWindowFoot(
  loaded: boolean,
  shown: number,
  total: number | null
): string | null {
  if (!loaded || shown === 0) return null;
  return total === null ? windowFootNoTotal(shown) : windowEnd(shown, total);
}

export const TALLY_PENDING_PREFIX = "tally:";

export function tallyPendingCount(
  pending: readonly { label: string }[]
): number {
  return pending.filter((change) =>
    change.label.startsWith(TALLY_PENDING_PREFIX)
  ).length;
}

export function tallyHasParked(
  pending: readonly { status: string; label: string }[]
): boolean {
  return pending.some(
    (change) =>
      change.label.startsWith(TALLY_PENDING_PREFIX) &&
      change.status === "parked"
  );
}

export function tallyHasConflict(
  pending: readonly { status: string; label: string }[]
): boolean {
  return pending.some(
    (change) =>
      change.label.startsWith(TALLY_PENDING_PREFIX) &&
      change.status === "conflict"
  );
}

export function clockAt(iso: string): string | null {
  const stamp = Date.parse(iso);
  if (Number.isNaN(stamp)) return null;
  const at = new Date(stamp);
  const hh = String(at.getHours()).padStart(2, "0");
  const mm = String(at.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export interface OutboxRow {
  id: string;
  status: string;
  label: string;
  reason?: string;
}

export function outboxAction(label: string): string {
  const at = label.indexOf(":");
  return at < 0 ? "" : label.slice(at + 1).trim();
}

export function outboxIntents(
  rows: readonly OutboxRow[],
  me: string | null
): Intent[] {
  return rows
    .filter((row) => row.label.startsWith(TALLY_PENDING_PREFIX))
    .map((row) => ({
      intentId: row.id,
      actorPartyId: me ?? "",
      command: outboxAction(row.label),
      input: {},
      status: row.status,
      ...(row.reason ? { reason: row.reason } : {}),
      createdAt: "",
    }));
}

export const TALLY_CONTRIB_DOORS: ContribDoors = {
  approvals: true,
  cancel: true,
  decide: false,
  discard: true,
  retry: true,
};

export function tallyWaiting(
  rows: readonly OutboxRow[],
  me: string | null
): ContribSections {
  return contribSections({
    doors: TALLY_CONTRIB_DOORS,
    intents: outboxIntents(rows, me),
    me: me ?? "",
    names: new Map<string, string>(),
  });
}

export function findEntry<T extends { expense_id: string }>(
  sources: readonly (readonly T[] | undefined | null)[],
  expenseId: string
): T | null {
  for (const source of sources) {
    const hit = source?.find((entry) => entry.expense_id === expenseId);
    if (hit) return hit;
  }
  return null;
}
