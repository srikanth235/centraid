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
