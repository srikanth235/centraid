import type { ReactNode } from "react";

import type { SearchStatus } from "../../_shared/search-scaffold.ts";
import {
  ACTIVITY,
  EXPORT,
  FRIEND,
  GROUP,
  GROUPS,
  SEARCH,
  SPENDING,
  TRASH,
} from "../shelves.ts";
import type { ShelfId } from "../shelves.ts";
import type {
  ActivityData,
  DashboardData,
  FriendData,
  GroupData,
  LedgerEntry,
  SearchData,
} from "../types.ts";
import type { ComposeView } from "./ComposeRoutes.tsx";
import { ComposeRoutes } from "./ComposeRoutes.tsx";
import { FriendScreen, GroupLedger } from "./Ledgers.tsx";
import { Search, Spending, Trash } from "./Lenses.tsx";
import { Activity, Balances, Groups } from "./Screens.tsx";
import { DayOne, DeniedGate } from "./States.tsx";

export interface RouteProps {
  shelf: ShelfId;
  consent: { message: string; revokedAt: string | null } | null;
  dashboard: DashboardData;
  group: GroupData | null;
  friend: FriendData | null;
  activity: ActivityData | null;
  search: { query: string; status: SearchStatus; data: SearchData | null };
  compose: ComposeView;
  now: string;
  activityWindow: number;
  narrow: boolean;
  compact: boolean;
  offline: boolean;
  meName: string;
  go: (shelf: ShelfId) => void;
  onOpenGroup: (groupId: string) => void;
  onOpenFriend: (partyId: string) => void;
  onOpenExpense: (entry: LedgerEntry) => void;
  onShowMore: () => void;
  onAskLeave: (groupId: string) => void;
  onAskArchive: (groupId: string, archived: boolean) => void;
  onSimplify: (groupId: string, simplify: boolean) => void;
  onRemind: (input: {
    partyId: string;
    name: string;
    groupId: string | null;
    asOfMinor: number;
  }) => void;
  onAskRemove: (partyId: string) => void;
  onAddFriend: () => void;
  onNewGroup: () => void;
  onRename: () => void;
  onAddMember: () => void;
  onDeleteGroup: () => void;
  onAddExpense: () => void;
  onSettle: () => void;
  onRestore: (expenseId: string) => void;
  onBack: () => void;
  onWaiting: () => void;
  onSaveExport: () => void;
  onQuery: (value: string) => void;
  onRetry: () => void;
}

export function Route(props: RouteProps): ReactNode {
  const { shelf, dashboard } = props;
  if (props.consent)
    return (
      <DeniedGate
        receipt={props.consent.message}
        revokedAt={props.consent.revokedAt}
      />
    );

  if (shelf === null) {
    const dayOne =
      dashboard.friends.length === 0 && dashboard.groups.length === 0;
    return dayOne ? (
      <DayOne onAdd={props.onAddExpense} />
    ) : (
      <Balances
        data={dashboard}
        narrow={props.narrow}
        onOpenFriend={props.onOpenFriend}
        onOpenGroup={props.onOpenGroup}
        onAddFriend={props.onAddFriend}
        onNewGroup={props.onNewGroup}
        onSettle={props.onSettle}
        onSpending={() => props.go(SPENDING)}
        onRemind={(friend) =>
          props.onRemind({
            partyId: friend.party_id,
            name: friend.name,
            groupId: null,
            asOfMinor: friend.net_minor,
          })
        }
      />
    );
  }

  if (shelf === ACTIVITY) {
    return props.activity ? (
      <Activity
        data={props.activity}
        now={props.now}
        window={props.activityWindow}
        narrow={props.narrow}
        onShowMore={props.onShowMore}
      />
    ) : null;
  }

  if (shelf === GROUPS) {
    return (
      <Groups
        data={dashboard}
        narrow={props.narrow}
        onOpenGroup={props.onOpenGroup}
        onNewGroup={props.onNewGroup}
        onLeave={props.onAskLeave}
        onArchive={props.onAskArchive}
      />
    );
  }

  if (shelf === GROUP) {
    return props.group ? (
      <GroupLedger
        data={props.group}
        narrow={props.narrow}
        onAddExpense={props.onAddExpense}
        onExport={() => props.go(EXPORT)}
        onAddSomeone={props.onAddMember}
        onRemoveMember={props.onAskRemove}
        onOpenExpense={props.onOpenExpense}
        onSettle={props.onSettle}
        onRename={props.onRename}
        onDelete={props.onDeleteGroup}
        onLeave={() => props.onAskLeave(props.group?.group?.group_id ?? "")}
        onArchive={() =>
          props.onAskArchive(
            props.group?.group?.group_id ?? "",
            Boolean(props.group?.group?.archived_at)
          )
        }
        onSimplify={(simplify) =>
          props.onSimplify(props.group?.group?.group_id ?? "", simplify)
        }
      />
    ) : null;
  }

  if (shelf === FRIEND) {
    return props.friend ? (
      <FriendScreen
        data={props.friend}
        groups={dashboard.groups}
        narrow={props.narrow}
        onOpenGroup={props.onOpenGroup}
        onOpenExpense={props.onOpenExpense}
        onSettle={props.onSettle}
      />
    ) : null;
  }

  if (shelf === SPENDING) {
    return props.activity ? (
      <Spending data={props.activity} now={props.now} narrow={props.narrow} />
    ) : null;
  }

  if (shelf === TRASH) {
    return (
      <Trash
        rows={dashboard.trash}
        currency={dashboard.currency}
        narrow={props.narrow}
        onRestore={props.onRestore}
      />
    );
  }

  if (shelf === SEARCH) {
    return (
      <Search
        query={props.search.query}
        status={props.search.status}
        data={props.search.data}
        narrow={props.narrow}
        onQuery={props.onQuery}
        onClear={() => props.onQuery("")}
        onRetry={props.onRetry}
        onOpenExpense={props.onOpenExpense}
      />
    );
  }

  return (
    <ComposeRoutes
      shelf={shelf}
      dashboard={dashboard}
      group={props.group}
      compose={props.compose}
      now={props.now}
      narrow={props.narrow}
      compact={props.compact}
      offline={props.offline}
      meName={props.meName}
      go={props.go}
      onBack={props.onBack}
      onWaiting={props.onWaiting}
      onSaveExport={props.onSaveExport}
    />
  );
}
