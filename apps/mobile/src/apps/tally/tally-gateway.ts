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

export const EXPORT_WINDOW = 2000;

export function tallyDashboard(): Promise<DashboardData> {
  return appQuery<DashboardData>("tally", "dashboard", {});
}

export function tallyGroup(groupId: string): Promise<GroupData> {
  return appQuery<GroupData>("tally", "group", { group_id: groupId });
}

export function tallyFriend(partyId: string): Promise<FriendData> {
  return appQuery<FriendData>("tally", "friend", { party_id: partyId });
}

export function tallyActivity(): Promise<ActivityData> {
  return appQuery<ActivityData>("tally", "activity", {});
}

export function tallySearch(term: string): Promise<SearchData> {
  return appQuery<SearchData>("tally", "search", { term });
}

export function tallyHistory(expenseId: string): Promise<HistoryData> {
  return appQuery<HistoryData>("tally", "history", { expense_id: expenseId });
}

export function tallyExport(groupId: string): Promise<ExportData> {
  return appQuery<ExportData>("tally", "export", {
    group_id: groupId,
    limit: EXPORT_WINDOW,
  });
}
