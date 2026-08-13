// DATA — every store the vault keeps (#765, spec §6).
//
// Net-new on the phone: Home's Data row used to be a stated no-op, because
// nothing here could read the vault's own tables. It now reads the four owner
// census endpoints in `lib/atlas.ts` and shows exactly what they answer.
//
// TWO VERBS THE REFERENCE HAS AND THIS BAR DOES NOT:
//  • the filled commit — the reference sets `a1:''` for this page on purpose
//    (a place that shows you what you already have commits to nothing);
//  • `Export a kind` — there is no export route reachable from this app, and a
//    quiet verb that opens nothing is worse than an absent one. It belongs
//    here the day the gateway serves the export the desktop offers.
//
// AND THREE CLAUSES: the reference's `12 written today` sub clause, its
// per-kind `4 min` meta column and its `Written today` filter chip all rest on
// a write pulse the census does not carry. See `data-model.ts`.
//
// The five states are the shared set: loading is the skeleton at row geometry
// plus the reflow note, empty is the routine empty block, error is the net
// panel (which an unpaired phone also lands on, with the pairing sentence
// rather than the store's), and ready/full differ only by the filter chips.

import * as Clipboard from "expo-clipboard";
import React, { useCallback, useMemo, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";

import ChipsBlock from "../../kit/components/ChipsBlock";
import type {
  DocRecord,
  DocRowAction,
} from "../../kit/components/doc-table-model";
import DocTable from "../../kit/components/DocTable";
import EmptyBlock from "../../kit/components/EmptyBlock";
import { healthLineFor } from "../../kit/components/health-line";
import type { OpsState } from "../../kit/components/health-line";
import HealthLine from "../../kit/components/HealthLine";
import HomeKey from "../../kit/components/HomeKey";
import NoteBlock from "../../kit/components/NoteBlock";
import PanelBlock from "../../kit/components/PanelBlock";
import PlaceHeader from "../../kit/components/PlaceHeader";
import RowsBlock from "../../kit/components/RowsBlock";
import type { RowsBlockRow } from "../../kit/components/RowsBlock";
import SectionBlock from "../../kit/components/SectionBlock";
import SkeletonRows from "../../kit/components/SkeletonRows";
import { postStatus } from "../../kit/components/status-line";
import TopSafeArea from "../../kit/components/TopSafeArea";
import { useTheme } from "../../kit/theme";
import type { DataScreenProps } from "../../navigation";
import {
  FULL_AT,
  KIND_FILTERS,
  browseRecords,
  censusDetail,
  censusKinds,
  count,
  filterKinds,
  recordCount,
  relationRows,
  tableCaption,
} from "./data-model";
import type { KindFilter, RecordView } from "./data-model";
import { styles } from "./Data.styles";
import RecordSheet from "./RecordSheet";
import { useData } from "./useData";
import type { DataState } from "./useData";

/** The place's own words. Verbatim from the reference where the payload
 *  supports them; the two error plates below are this app's, because the
 *  reference has no unpaired-phone state. */
const COPY = {
  emptyBody:
    "Kinds appear here as apps write records. Nothing is created until an app or an import puts something in.",
  emptyTitle: "This vault is empty",
  errorBody:
    "The vault is encrypted and present on disk. The gateway could not open it, which is usually a permissions problem on the machine rather than damage to the data.",
  errorTitle: "Cannot open the store",
  healthEmpty: "Nothing to attend to · nothing needs you here right now.",
  healthError:
    "This page could not load · everything else on the gateway is unaffected.",
  healthLabel: "Everything is readable",
  healthLoading: "Reading from the gateway",
  kindsNote:
    "A kind is a shape of record an app writes. Sizes include every version kept.",
  loadingNote:
    "A row knows its shape before its content arrives, so nothing reflows when it does.",
  noGatewayBody:
    "This phone is not paired with a gateway yet. The vault and everything in it are on your own machine, waiting; pair from Settings and its kinds appear here.",
  noGatewayTitle: "Not connected to a gateway",
  relations: "How they relate",
  retry: "Try again",
  sectionKinds: "Kinds",
  title: "Data",
} as const;

/** The record menu's words. `Open the record` and `Copy the id` are wired to
 *  what this app can do; the other two name where the act actually happens,
 *  because `lib/atlas.ts` is a READ surface — a row edit on this gateway is a
 *  journalled operator command, and the phone cannot make one. */
const RECORD_MENU = {
  copyId: "Copy the id",
  delete: "Delete on the desktop",
  edit: "Edit on the desktop",
  more: (title: string) => `More for ${title}`,
  open: "Open the record",
};

const DESKTOP_ONLY =
  "Records are edited and deleted on the desktop. The phone reads the store; every write here is a receipted operator act.";

const COPIED = "Copied the id.";

/** Which of the five states the payload is in. `full` is data-driven — the
 *  chips appear because the list got long, never because a mode was set. */
function opsStateOf(state: DataState, kinds: number): OpsState {
  if (state.kind === "loading") return "loading";
  if (state.kind === "error" || state.kind === "no-gateway") return "error";
  if (kinds === 0) return "empty";
  return kinds > FULL_AT ? "full" : "ready";
}

export default function DataScreen({
  navigation,
  route,
}: DataScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const { state, refreshing, refresh, browseKind } = useData(
    route.params?.kind
  );
  const [filter, setFilter] = useState<KindFilter>("all");
  const [opened, setOpened] = useState<RecordView | undefined>(undefined);

  const kinds = useMemo(
    () => (state.kind === "ready" ? censusKinds(state.census) : []),
    [state]
  );
  const shownKinds = useMemo(() => filterKinds(kinds, filter), [kinds, filter]);
  const relations = useMemo(
    () =>
      state.kind === "ready" && state.graph ? relationRows(state.graph) : [],
    [state]
  );
  const records = useMemo(
    () =>
      state.kind === "ready" && state.browse
        ? browseRecords(state.browse.page)
        : [],
    [state]
  );

  const opsState = opsStateOf(state, kinds.length);
  const health = healthLineFor(opsState, {
    detail: state.kind === "ready" ? censusDetail(state.census) : "",
    emptyText: COPY.healthEmpty,
    errorText: COPY.healthError,
    label: COPY.healthLabel,
    loadingText: COPY.healthLoading,
  });

  const onRowAction = useCallback(
    (record: DocRecord, action: DocRowAction): void => {
      const view = records.find((entry) => entry.id === record.key);
      if (!view) return;
      if (action === "open") {
        setOpened(view);
        return;
      }
      if (action === "copyId") {
        void Clipboard.setStringAsync(view.id).then(() => postStatus(COPIED));
        return;
      }
      postStatus(DESKTOP_ONLY);
    },
    [records]
  );

  const kindRows: RowsBlockRow[] = shownKinds.map((kind) => ({
    action: {
      hint: `Browse ${kind.title}`,
      label: "Browse",
      onPress: () => browseKind(kind.logical),
    },
    key: kind.logical,
    sub: kind.sub,
    title: kind.title,
  }));

  const relationRowDefs: RowsBlockRow[] = relations.map((relation) => ({
    action: {
      hint: `Browse ${relation.title}`,
      label: "Browse",
      onPress: () => browseKind(relation.browse),
    },
    key: relation.key,
    sub: relation.sub,
    title: relation.title,
  }));

  const browse = state.kind === "ready" ? state.browse : undefined;

  return (
    <TopSafeArea edges={["top"]} style={{ backgroundColor: colors.bg }}>
      <View style={styles.page}>
        <View style={styles.head}>
          {/* No verbs at all: see the file header. */}
          <PlaceHeader title={COPY.title} />
        </View>
        <ScrollView
          contentContainerStyle={styles.scroll}
          refreshControl={
            <RefreshControl
              onRefresh={() => void refresh()}
              refreshing={refreshing}
              tintColor={colors.textFaint}
            />
          }
        >
          {opsState === "loading" ? (
            <>
              <SkeletonRows accessibilityLabel="Reading what the vault holds" />
              <NoteBlock text={COPY.loadingNote} />
            </>
          ) : null}

          {opsState === "error" ? (
            <PanelBlock
              body={
                state.kind === "no-gateway"
                  ? COPY.noGatewayBody
                  : COPY.errorBody
              }
              action={{ label: COPY.retry, onPress: () => void refresh() }}
              title={
                state.kind === "no-gateway"
                  ? COPY.noGatewayTitle
                  : COPY.errorTitle
              }
              tone="net"
            />
          ) : null}

          {opsState === "empty" ? (
            // No action: nothing on this page creates a kind, and an empty
            // vault is a healthy state rather than an incident.
            <EmptyBlock body={COPY.emptyBody} routine title={COPY.emptyTitle} />
          ) : null}

          {opsState === "ready" || opsState === "full" ? (
            <>
              {opsState === "full" ? (
                <ChipsBlock
                  accessibilityLabel="Filter the kinds"
                  chips={KIND_FILTERS.map((chip) => ({
                    id: chip.id,
                    label: chip.label,
                    on: chip.id === filter,
                    onPress: () => setFilter(chip.id),
                  }))}
                />
              ) : null}
              <SectionBlock
                label={COPY.sectionKinds}
                meta={count(shownKinds.length)}
              />
              <RowsBlock rows={kindRows} />
              <NoteBlock text={COPY.kindsNote} />
              {relationRowDefs.length > 0 ? (
                <>
                  <SectionBlock
                    label={COPY.relations}
                    meta={count(relationRowDefs.length)}
                  />
                  <RowsBlock rows={relationRowDefs} />
                </>
              ) : null}
              {browse && records.length > 0 ? (
                <>
                  <SectionBlock
                    label={browse.table.label || browse.table.logical}
                    meta={recordCount(browse.table.rows)}
                  />
                  <DocTable
                    accessibilityLabel={`Records in ${browse.table.label || browse.table.logical}`}
                    caption={tableCaption(
                      records.length,
                      browse.table.rows,
                      browse.newestFirst
                    )}
                    copy={RECORD_MENU}
                    onRowAction={onRowAction}
                    records={records.map((entry) => entry.record)}
                  />
                </>
              ) : null}
            </>
          ) : null}
        </ScrollView>
        {/* No inline verb: the reference's `healthAction` is '' on this page,
            and there is nothing on a census to act on in one tap. */}
        <HealthLine text={health.text} />
      </View>
      <RecordSheet
        kindLabel={browse ? browse.table.label || browse.table.logical : ""}
        onClose={() => setOpened(undefined)}
        record={opened}
      />
      <HomeKey onPress={() => navigation.goBack()} variant="floating" />
    </TopSafeArea>
  );
}
