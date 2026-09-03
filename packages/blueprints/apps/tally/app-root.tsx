import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";

import {
  observeWidth,
  onDataChange,
  onFocusRefresh,
} from "@centraid/design/elements";

import { libraryReachability } from "../_shared/view-state-kit.ts";
import type { InlineAppProps } from "../inline-types.ts";
import { ACTIVITY_STEP, ACTIVITY_WINDOW } from "./activity-model.ts";
import { Chrome } from "./Chrome.tsx";
import { BackRow } from "./components/Blocks.tsx";
import { SearchField } from "./components/Lenses.tsx";
import { Rail } from "./components/Rail.tsx";
import { RoomOverlays } from "./components/RoomOverlays.tsx";
import { Route } from "./components/Route.tsx";
import { Notices } from "./components/States.tsx";
import { useComposeActs } from "./compose-acts.ts";
import { useComposeState, useReceiptShot } from "./compose-state.ts";
import { useContribReads } from "./contrib-reads.ts";
import { expenseVerdict, settleVerdict } from "./draft-model.ts";
import { useExportRead } from "./export-read.ts";
import { money } from "./format.ts";
import { appBar, bandClaim } from "./frame.tsx";
import { CHANGE_TABLES, useLedgerReads } from "./ledger-reads.ts";
import { useLedgerSearch } from "./ledger-search.ts";
import { useRoomSheets } from "./room-sheets.ts";
import { routeStatus } from "./route-copy.ts";
import {
  ADD,
  EXPENSE,
  FRIEND,
  GROUP,
  RECEIPT,
  SEARCH,
  SETTLE,
  WAITING,
  backShelf,
  bandShelf,
  shelfFromSegment,
  showsLedgerList,
} from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";
import type { LedgerEntry, Person } from "./types.ts";

export { CHANGE_TABLES } from "./ledger-reads.ts";

const ME_NAME = "You";

export function Root({
  rootRef,
  frame,
  compact = false,
}: InlineAppProps): ReactElement {
  const [shelf, setShelf] = useState<ShelfId>(null);
  const [routeGroupId, setRouteGroupId] = useState<string | null>(null);
  const [openFriendId, setOpenFriendId] = useState<string | null>(null);
  const [activityWindow, setActivityWindow] = useState(ACTIVITY_WINDOW);
  const [narrow, setNarrow] = useState(false);

  const rootElRef = useRef<HTMLDivElement | null>(null);
  const nowRef = useRef<string>(new Date().toISOString());

  const compose = useComposeState({ today: nowRef.current.slice(0, 10) });
  const bag = compose.bagRef.current;

  const openGroupId =
    shelf === GROUP || shelf === null ? routeGroupId : compose.groupId;

  const ledger = useLedgerReads({
    shelf,
    openGroupId,
    openFriendId,
    frame,
  });
  const { consent, dashboard, loaded } = ledger;
  const refresh = ledger.refresh;
  const search = useLedgerSearch();

  useEffect(() => {
    void refresh();
    const stopChanges = onDataChange(CHANGE_TABLES, () => void refresh());
    const stopFocus = onFocusRefresh(() => void refresh());
    return () => {
      stopChanges?.();
      stopFocus?.();
    };
  }, [refresh]);

  useEffect(() => {
    const element = rootElRef.current;
    if (!element) return;
    return observeWidth(element, 720, setNarrow);
  }, []);

  const setRoot = useCallback(
    (el: HTMLDivElement | null) => {
      rootElRef.current = el;
      rootRef(el);
    },
    [rootRef]
  );

  const go = useCallback(
    (next: ShelfId) => {
      setShelf(next);
      compose.close();
    },
    [compose]
  );

  const openGroup = useCallback(
    (groupId: string) => {
      ledger.forget("group");
      setRouteGroupId(groupId);
      setShelf(GROUP);
      compose.close();
    },
    [compose, ledger]
  );

  const openFriend = useCallback(
    (partyId: string) => {
      ledger.forget("friend");
      setOpenFriendId(partyId);
      setShelf(FRIEND);
      compose.close();
    },
    [compose, ledger]
  );

  const openExpense = useCallback(
    (entry: LedgerEntry) => {
      compose.openExpense(entry);
      setShelf(EXPENSE);
    },
    [compose]
  );

  const openAdd = useCallback(() => {
    compose.openAdd({
      groupId: openGroupId,
      payerId: dashboard.me ?? "",
      today: ledger.now.slice(0, 10),
      currency: dashboard.currency,
    });
    setShelf(ADD);
  }, [compose, dashboard.currency, dashboard.me, ledger.now, openGroupId]);

  const openSettle = useCallback(() => {
    compose.openSettle({
      fromId: dashboard.me ?? "",
      toId: openFriendId ?? "",
      groupId: openGroupId,
      today: ledger.now.slice(0, 10),
    });
    setShelf(SETTLE);
  }, [compose, dashboard.me, ledger.now, openFriendId, openGroupId]);

  const group = ledger.group;
  const members = useMemo(
    () => (group?.group?.group_id === compose.groupId ? group.members : []),
    [group, compose.groupId]
  );
  const entry: LedgerEntry | null =
    (group?.ledger ?? []).find((row) => row.expense_id === compose.expenseId) ??
    null;

  const seedSelection = compose.seedSelection;
  useEffect(() => {
    if (entry) seedSelection(entry);
  }, [entry, seedSelection]);

  const shotUrl = useReceiptShot(entry?.receipt?.content_uri, shelf, RECEIPT);

  const acts = useComposeActs({
    compose,
    ledger,
    members,
    currency: dashboard.currency,
    go,
    openGroupId,
  });

  const friends = dashboard.friends as readonly Person[];
  const contrib = useContribReads({
    me: dashboard.me,
    meName: ME_NAME,
    friends,
    matchedAt: ledger.matchedAt,
  });
  const candidates = useMemo(
    () =>
      friends.filter(
        (person) =>
          !members.some((member) => member.party_id === person.party_id)
      ),
    [friends, members]
  );

  const sheets = useRoomSheets({ compose, group, openGroupId });

  const exports = useExportRead({
    shelf,
    groupId: bag.exportDraft.groupId,
    range: bag.exportDraft.range,
    format: bag.exportDraft.format,
    say: ledger.say,
  });

  const reach = libraryReachability({
    hostStatus: rootElRef.current?.dataset.gatewayStatus ?? null,
    readFailed: ledger.readFailed,
  });
  const offline = reach === "unreachable";
  const loadedLedger = ledger.group?.ledger ?? ledger.friend?.ledger ?? [];
  const groupIsShared = (ledger.group?.members.length ?? 0) > 1;
  const conflict = loadedLedger.some((row) => row.intentStatus === "conflict");
  const groupName = openGroupId
    ? dashboard.groups.find((row) => row.group_id === openGroupId)?.name
    : undefined;
  const friendName = openFriendId
    ? dashboard.friends.find((row) => row.party_id === openFriendId)?.name
    : undefined;

  const back = backShelf(shelf);
  const goBack = useCallback(() => {
    if (back) go(back.shelf);
  }, [back, go]);

  const scroll = (
    <Route
      shelf={shelf}
      consent={consent}
      dashboard={dashboard}
      group={ledger.group}
      friend={ledger.friend}
      activity={ledger.activity}
      search={{
        query: search.query,
        status: search.status,
        data: search.data,
      }}
      compose={{
        state: compose,
        acts,
        bag,
        entry,
        verdict: expenseVerdict(
          bag.draft,
          members.map((member) => member.party_id),
          dashboard.currency,
          dashboard.me,
          money
        ),
        settleVerdict: settleVerdict(bag.settle, dashboard.me),
        contrib: contrib.sections,
        hasApprovals: contrib.hasApprovals,
        canDecide: contrib.canDecide,
        exportData: exports.data,
        shotUrl,
        members,
      }}
      now={ledger.now || nowRef.current}
      activityWindow={activityWindow}
      narrow={narrow}
      compact={compact}
      offline={offline}
      meName={ME_NAME}
      go={go}
      onOpenGroup={openGroup}
      onOpenFriend={openFriend}
      onOpenExpense={openExpense}
      onShowMore={() => setActivityWindow((size) => size + ACTIVITY_STEP)}
      onAskLeave={(groupId) => compose.show({ kind: "leave", groupId })}
      onAskArchive={(groupId, archived) =>
        compose.show({ kind: "archive", groupId, archived })
      }
      onSimplify={(groupId, simplify) => acts.setSimplify(groupId, simplify)}
      onRemind={(input) => acts.nudge(input)}
      onSaveExport={() => exports.save()}
      onAskRemove={(partyId) => sheets.askRemove(partyId)}
      onAddFriend={() => sheets.askFriend()}
      onNewGroup={() => sheets.askGroup()}
      onRename={() => sheets.askRename()}
      onAddMember={() => sheets.askMember()}
      onDeleteGroup={() => sheets.askDeleteGroup()}
      onAddExpense={openAdd}
      onSettle={openSettle}
      onRestore={(expenseId) => acts.restore(expenseId)}
      onBack={goBack}
      onWaiting={() => go(WAITING)}
      onQuery={(value) => search.onQuery(value)}
      onRetry={() => search.retry()}
    />
  );

  const handedOff = compact || narrow;

  useEffect(() => {
    frame.setAppBar(
      appBar({
        shelf,
        ...(groupName && shelf === GROUP ? { subjectName: groupName } : {}),
        ...(friendName && shelf === FRIEND ? { subjectName: friendName } : {}),
        count: null,
        compact: handedOff,
        quiet: consent !== null || !loaded,
        onSelect: go,
        onAddExpense: openAdd,
        onSettle: openSettle,
        onEdit: () => {
          if (entry) acts.openEditFrom(entry);
          setShelf(ADD);
        },
        onItemise: () => setShelf(RECEIPT),
      })
    );
  }, [
    frame,
    shelf,
    groupName,
    friendName,
    handedOff,
    consent,
    loaded,
    go,
    openAdd,
    openSettle,
    acts,
    entry,
  ]);

  useEffect(() => {
    frame.setStatus(routeStatus(shelf, groupIsShared));
  }, [frame, shelf, groupIsShared]);

  useEffect(() => {
    if (!narrow) {
      frame.claimBand(null);
      return;
    }
    frame.claimBand(
      bandClaim(
        shelf,
        (segment) => go(shelfFromSegment(segment)),
        () => compose.show({ kind: "more" })
      )
    );
  }, [frame, shelf, narrow, go, compose]);

  useEffect(() => {
    return () => {
      frame.setAppBar(null);
      frame.claimBand(null);
      frame.clearStatus();
    };
  }, [frame]);

  return (
    <div
      ref={setRoot}
      data-gateway-status={offline ? "down" : undefined}
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minWidth: 0,
        minHeight: 0,
      }}
    >
      <Chrome
        narrow={narrow}
        loading={!loaded}
        consent={consent}
        slots={{
          rail:
            narrow || consent || !showsLedgerList(shelf) ? null : (
              <Rail
                current={bandShelf(shelf)}
                openGroupId={shelf === GROUP ? openGroupId : null}
                openFriendId={shelf === FRIEND ? openFriendId : null}
                groups={dashboard.groups}
                friends={dashboard.friends}
                onSelect={go}
                onOpenGroup={openGroup}
                onOpenFriend={openFriend}
              />
            ),
          backRow: back ? <BackRow label={back.label} onBack={goBack} /> : null,
          notices: consent ? null : (
            <Notices
              pendingWriteCount={ledger.queued}
              offline={offline}
              staleAt={
                offline && ledger.matchedAt
                  ? ledger.matchedAt.slice(11, 16)
                  : null
              }
              parked={ledger.parked}
              conflict={conflict}
              onWaiting={() => go(WAITING)}
              onRefresh={() => void refresh()}
            />
          ),
          toolbar:
            shelf === SEARCH && !consent ? (
              <SearchField
                query={search.query}
                onQuery={(value) => search.onQuery(value)}
              />
            ) : null,
          scroll,
          overlays: (
            <RoomOverlays
              overlay={bag.overlay}
              compose={compose}
              friends={friends}
              candidates={candidates}
              onNavigate={go}
              onRemove={(partyId) => acts.removeMember(partyId)}
              onCommit={() => acts.commitSheet()}
            />
          ),
        }}
      />
    </div>
  );
}
