// CONNECTORS — what is allowed to reach outside this vault (#765, spec §4). Consent surface: one verb per state. `net` only on a broken connection's metadata — the NAME stays primary ink (the credential is the problem).
// TWO VERBS ARE WITHHELD, ON PURPOSE: no BYO wizard or Assist onboarding on phone, no mobile catalog client. A verb that opened nothing would be worse than a bar with no verbs.
// ATTACHED DATA SYNCS IS OMITTED, ON PURPOSE: the gateway serves no such plane; do not invent it from a name-matching guess.

import React, { useMemo } from "react";
import { RefreshControl, ScrollView, View } from "react-native";

import {
  CONNECTORS_EMPTY_BODY,
  CONNECTORS_EMPTY_TITLE,
  CONNECTORS_ERROR_BODY,
  CONNECTORS_ERROR_TITLE,
} from "@centraid/client/connectors-copy";
import { RETRY_ACTION, SKELETON_NOTE } from "@centraid/client/surface-copy";

import ChipsBlock from "../../kit/components/ChipsBlock";
import EmptyBlock from "../../kit/components/EmptyBlock";
import FeatureOffPlace from "../../kit/components/FeatureOffPlace";
import { healthLineFor } from "../../kit/components/health-line";
import HealthLine from "../../kit/components/HealthLine";
import HomeKey from "../../kit/components/HomeKey";
import { Text } from "../../kit/components/NativeText";
import NoteBlock from "../../kit/components/NoteBlock";
import PanelBlock from "../../kit/components/PanelBlock";
import PlaceHeader from "../../kit/components/PlaceHeader";
import RowsBlock from "../../kit/components/RowsBlock";
import SectionBlock from "../../kit/components/SectionBlock";
import SkeletonRows from "../../kit/components/SkeletonRows";
import TopSafeArea from "../../kit/components/TopSafeArea";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import { useTheme } from "../../kit/theme";
import type { ConnectorsScreenProps } from "../../navigation";
import {
  connectorRow,
  connectorsHealth,
  countSentence,
  filterChips,
  firstNeedingAuth,
  matchesFilter,
  showingSentence,
} from "./connectors-model";
import { styles } from "./Connectors.styles";
import { useConnectors } from "./useConnectors";
import type { ConnectorsController } from "./useConnectors";

const ERROR_EYEBROW = "THIS PAGE COULD NOT LOAD";
const ERROR_TITLE = CONNECTORS_ERROR_TITLE;
const ERROR_BODY = CONNECTORS_ERROR_BODY;
const ERROR_RETRY = RETRY_ACTION;

const EMPTY_TITLE = CONNECTORS_EMPTY_TITLE;
const EMPTY_BODY = CONNECTORS_EMPTY_BODY;

const LOADING_NOTE = SKELETON_NOTE;

function ConnectorsBody({
  page,
}: {
  page: ConnectorsController;
}): React.JSX.Element {
  const { connections, filter, now, state } = page;

  if (state === "loading")
    return (
      <>
        <SkeletonRows accessibilityLabel="Reading your connections" />
        <NoteBlock text={LOADING_NOTE} />
      </>
    );

  if (state === "error")
    return (
      <PanelBlock
        body={ERROR_BODY}
        eyebrow={ERROR_EYEBROW}
        facts={
          page.load.kind === "error"
            ? [
                {
                  key: "what happened",
                  net: true,
                  value: page.load.reason,
                },
              ]
            : undefined
        }
        action={{ label: ERROR_RETRY, onPress: page.retry }}
        title={ERROR_TITLE}
        tone="net"
      />
    );

  if (state === "empty")
    return <EmptyBlock body={EMPTY_BODY} routine title={EMPTY_TITLE} />;

  const full = state === "full";
  const shown = full
    ? connections.filter((entry) => matchesFilter(entry, filter))
    : connections;
  return (
    <>
      {full ? (
        <ChipsBlock
          accessibilityLabel="Filter connections"
          chips={filterChips(filter).map((chip) => ({
            id: chip.key,
            label: chip.label,
            on: chip.on,
            onPress: () => page.setFilter(chip.key),
          }))}
        />
      ) : null}
      <SectionBlock
        label="Connections"
        meta={
          shown.length === connections.length
            ? countSentence(connections)
            : showingSentence(shown.length, connections.length)
        }
      />
      <RowsBlock
        accessibilityLabel="Connections"
        rows={shown.map((entry) => {
          const row = connectorRow(entry, now);
          return {
            action: {
              hint: `${row.action} ${row.title}`,
              label: row.action,
              onPress: () => page.perform(row.connectionId, row.act),
            },
            key: row.key,
            meta: row.meta,
            net: row.net,
            sub: row.sub,
            title: row.title,
          };
        })}
      />
    </>
  );
}

/**
 * Gate above the page so a connectors-off gateway never mounts `useConnectors` (that would dress a 404 as a page error). `undefined` is unknown, not off.
 */
export default function ConnectorsScreen(
  props: ConnectorsScreenProps
): React.JSX.Element {
  const { features } = useReplica();
  if (features && !features.connectors)
    return (
      <FeatureOffPlace
        feature="connectors"
        onLeave={() => props.navigation.goBack()}
        title="Connectors"
      />
    );
  return <ConnectorsPlace {...props} />;
}

function ConnectorsPlace({
  navigation,
}: ConnectorsScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const page = useConnectors();
  const ink = useMemo(
    () => ({
      error: { color: colors.net },
      safe: { backgroundColor: colors.bg },
    }),
    [colors]
  );
  // Clock is the one the read landed at (`useConnectors`) — relative phrases agree and do not age without a re-read.
  const health = healthLineFor(
    page.state,
    connectorsHealth(page.connections, page.now)
  );
  const lapsed = firstNeedingAuth(page.connections);

  return (
    <TopSafeArea edges={["top"]} style={[styles.safe, ink.safe]}>
      <View style={styles.page}>
        <View style={styles.head}>
          <HomeKey onPress={() => navigation.goBack()} variant="leave" />
          <View style={styles.headBar}>
            {/* No verbs — see the file header. */}
            <PlaceHeader title="Connectors" />
          </View>
        </View>
        <ScrollView
          contentContainerStyle={styles.body}
          refreshControl={
            <RefreshControl
              onRefresh={() => void page.refresh()}
              refreshing={page.refreshing}
              tintColor={colors.textFaint}
            />
          }
        >
          {page.actionError ? (
            <Text style={[styles.actionError, ink.error]}>
              {page.actionError}
            </Text>
          ) : null}
          <ConnectorsBody page={page} />
        </ScrollView>
      </View>
      <HealthLine
        action={lapsed ? health.action : undefined}
        onAction={
          lapsed
            ? () => page.perform(lapsed.connectionId, "reauthorize")
            : undefined
        }
        text={health.text}
      />
    </TopSafeArea>
  );
}
