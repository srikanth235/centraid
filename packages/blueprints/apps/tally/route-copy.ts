import {
  ACTIVITY,
  ADD,
  EXPENSE,
  FRIEND,
  GROUP,
  GROUPS,
  RECEIPT,
  RECURRING,
  SEARCH,
  SETTLE,
  SPENDING,
  TRASH,
  WAITING,
} from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";
import { MORE_META, ROUTE_STATUS } from "./view-copy.ts";

export function routeStatus(shelf: ShelfId, shared: boolean): string {
  if (shelf === null) return ROUTE_STATUS.balances;
  if (shelf === ACTIVITY) return ROUTE_STATUS.activity;
  if (shelf === GROUPS) return ROUTE_STATUS.groups;
  if (shelf === GROUP) {
    return shared ? ROUTE_STATUS.group : ROUTE_STATUS.groupOwn;
  }
  if (shelf === FRIEND) return ROUTE_STATUS.friend;
  if (shelf === EXPENSE) return ROUTE_STATUS.expense;
  if (shelf === ADD) return ROUTE_STATUS.add;
  if (shelf === RECEIPT) return ROUTE_STATUS.receipt;
  if (shelf === SETTLE) return ROUTE_STATUS.settle;
  if (shelf === RECURRING) return ROUTE_STATUS.recurring;
  if (shelf === WAITING) return ROUTE_STATUS.contrib;
  if (shelf === SPENDING) return ROUTE_STATUS.insight;
  if (shelf === TRASH) return ROUTE_STATUS.trash;
  if (shelf === SEARCH) return ROUTE_STATUS.search;
  return ROUTE_STATUS.export;
}

export function moreMeta(shelf: ShelfId): string {
  if (shelf === RECURRING) return MORE_META.recurring;
  if (shelf === SPENDING) return MORE_META.insight;
  if (shelf === SEARCH) return MORE_META.search;
  if (shelf === TRASH) return MORE_META.trash;
  return MORE_META.export;
}
