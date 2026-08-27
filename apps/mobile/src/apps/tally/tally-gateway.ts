// THE SEVEN READS, and why they are RPCs rather than replica scans.
//
// ONE BALANCE ENGINE, AND IT IS `queries/dashboard.ts`'s. Every net, share and
// total in Tally is derived at read time by that one engine (spec §2), and the
// interface never recomputes one. Folding balances out of the phone's replica
// rows would be a SECOND engine — two derivations of "who owes whom", drifting
// apart the first time either changed — so this seat asks the same query
// handlers every other seat asks and renders what comes back.
//
// WRITES ARE THE OTHER DIRECTION AND TAKE THE OTHER DOOR. `tally-writes.ts`
// issues every act through `session.write`, which projects an optimistic copy
// and keeps the intent in the durable outbox until the gateway answers
// (`apps/tally/pending-projection.ts`). That is what "Tally is record-only and
// fully offline-capable" means on a phone: recording never needs the gateway,
// reading a DERIVED figure does, and the offline notice says exactly that.
//
// The functions are thin on purpose. They name the query, they name what comes
// back, and they leave every decision about what a payload MEANS to
// `tally-store.ts` and to the pure blueprint modules it composes.

import type {
  ActivityData,
  DashboardData,
  ExportData,
  FriendData,
  GroupData,
  HistoryData,
  SearchData,
} from "@centraid/blueprints/apps/tally/types";

import { appQuery } from "../../lib/gateway";

/** The window Export asks for. The query's own default; its ceiling is its
 *  own business, and `truncated` is how the payload says it was reached. */
export const EXPORT_WINDOW = 2000;

/** The spine. Every route reads it, and a route that needs a second payload
 *  asks for exactly that one (`apps/tally/ledger-reads.ts`'s own law). */
export function tallyDashboard(): Promise<DashboardData> {
  return appQuery<DashboardData>("tally", "dashboard", {});
}

/** One group's members, their nets, its ledger and its simplification. */
export function tallyGroup(groupId: string): Promise<GroupData> {
  return appQuery<GroupData>("tally", "group", { group_id: groupId });
}

/** Every part of one net — groups, group-less, and People's obligations. */
export function tallyFriend(partyId: string): Promise<FriendData> {
  return appQuery<FriendData>("tally", "friend", { party_id: partyId });
}

/** Expenses and settlements interleaved, newest first. */
export function tallyActivity(): Promise<ActivityData> {
  return appQuery<ActivityData>("tally", "activity", {});
}

/** Descriptions only. The query matches nothing else, and the surface says so. */
export function tallySearch(term: string): Promise<SearchData> {
  return appQuery<SearchData>("tally", "search", { term });
}

/** One expense's durable revisions, with the undo window on each. */
export function tallyHistory(expenseId: string): Promise<HistoryData> {
  return appQuery<HistoryData>("tally", "history", { expense_id: expenseId });
}

/**
 * One group's ledger as a file's worth of rows.
 *
 * READ HERE, WRITTEN NOWHERE FROM THIS SEAT. Export is `custodian` in
 * SURFACES.md's seat column — the file is saved beside the gateway — so this
 * phone reads the payload only to state honestly how much WOULD leave, and
 * says where the act happens (`tally-seat-copy.ts`).
 */
export function tallyExport(groupId: string): Promise<ExportData> {
  return appQuery<ExportData>("tally", "export", {
    group_id: groupId,
    limit: EXPORT_WINDOW,
  });
}
