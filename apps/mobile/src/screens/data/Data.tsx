import * as Clipboard from "expo-clipboard";
import React, { useCallback, useMemo, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";

import {
  ATLAS_EMPTY_BODY,
  ATLAS_EMPTY_TITLE,
  ATLAS_KINDS_NOTE,
} from "@centraid/client/data-copy";
import {
  EMPTY_HEALTH,
  RETRY_ACTION,
  SKELETON_NOTE,
} from "@centraid/client/surface-copy";

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
import { VAULT_SECTION_ORDER } from "../../kit/origin-seat-layout";
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
import { VaultCopiesSection, VaultSharingSection } from "./VaultSections";

const COPY = {
  emptyBody: ATLAS_EMPTY_BODY,
  emptyTitle: ATLAS_EMPTY_TITLE,
  errorBody:
    "The vault is on disk, but its home machine could not open it — usually permissions, not damage.",
  errorTitle: "Cannot open the store",
  healthEmpty: EMPTY_HEALTH,
  healthError: "Contents could not load",
  healthLabel: "Everything is readable",
  healthLoading: "Reading the vault contents",
  kindsNote: ATLAS_KINDS_NOTE,
  loadingNote: SKELETON_NOTE,
  noGatewayBody: "Link this phone from Settings to see the vault contents.",
  noGatewayTitle: "Not linked to a vault",
  relations: "How they relate",
  retry: RETRY_ACTION,
  sectionKinds: "Kinds",
  title: "Vault",
} as const;

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
    <TopSafeArea
      edges={["top"]}
      style={[styles.safe, { backgroundColor: colors.bg }]}
    >
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
          <SectionBlock label={VAULT_SECTION_ORDER[0]} />
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
          <VaultCopiesSection
            openCopies={() => navigation.navigate("Devices")}
          />
          <VaultSharingSection
            openSharing={() =>
              navigation.navigate("Settings", { screen: "Sharing" })
            }
          />
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
