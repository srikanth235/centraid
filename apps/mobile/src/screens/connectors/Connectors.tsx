// CONNECTORS — what is allowed to reach outside this vault (#765, spec §4).
//
// The page is a consent surface, and it is deliberately dull: a list of
// connections, the state each one is in, and the one verb that state permits.
// Colour is spent only on `net`, and only on the metadata of a connection that
// has stopped working — the connection's NAME stays primary ink, because the
// thing is not the problem, its credential is.
//
// TWO VERBS ARE WITHHELD, ON PURPOSE.
// The reference gives this bar `Add a connection` (filled) and `Catalog`
// (quiet), and gives its empty state `Open the catalog`. Neither exists on a
// phone: adding a connection means configuring a credential, which is either
// the BYO wizard (typing an OAuth client id and secret registered on the
// provider's console — a desktop act) or the Assist onboarding flow, and
// mobile has neither screen; the provider catalog itself
// (`GET /_vault/connections/providers`) has no mobile client, and `lib/` is
// not this screen's to grow. A bar verb that opened nothing, or a catalog
// rendered from strings this app invented, would both be worse than a bar with
// no verbs — this page's whole claim is that it tells the truth about reach.
// When mobile grows a catalog read, the verbs land here and nowhere else.
//
// ATTACHED DATA SYNCS IS OMITTED, ON PURPOSE.
// The reference's second section lists per-connection syncs. The gateway
// serves no such plane: the connections routes carry connections and their
// health (`packages/server/src/routes/connections-routes.ts`), and a "sync"
// is an automation grown from a pull blueprint whose rows
// (`lib/automations.ts`) carry no connection handle to join on. Rendering the
// section from a name-matching guess would put a claim about what leaves this
// vault on screen that nothing verified. The section's explanatory note goes
// with it — a sentence defining an object the page does not show is furniture.

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

/** The reference's own error copy: what failed, what is safe, one way forward. */
const ERROR_EYEBROW = "THIS PAGE COULD NOT LOAD";
const ERROR_TITLE = CONNECTORS_ERROR_TITLE;
const ERROR_BODY = CONNECTORS_ERROR_BODY;
const ERROR_RETRY = RETRY_ACTION;

/** The empty state, in the routine register — nothing connected is healthy. */
const EMPTY_TITLE = CONNECTORS_EMPTY_TITLE;
const EMPTY_BODY = CONNECTORS_EMPTY_BODY;

/** Why a skeleton, said once, under the skeleton. */
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
    // No action: the reference's `Open the catalog` has nothing to open here
    // (see the file header). The sentence still says what a connector is and
    // that revoking one lives on this page, which is the part that matters.
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
 * The gate, above the page. Split from `ConnectorsPlace` rather than checked
 * inside it so a gateway with connectors switched off never mounts
 * `useConnectors` — the hook would read routes this gateway does not serve and
 * dress a 404 as a page error. `undefined` is unknown, not off: no gateway has
 * answered yet, and the page's own error state already covers one that will
 * not talk.
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
  // The clock is the one the read landed at (see `useConnectors`), so every
  // relative phrase on the page agrees, and none of them ages without a
  // re-read behind it.
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
            {/* No verbs — see the file header. The gating rule the caller
                would apply (commit hidden on loading AND error, quiet verb
                hidden on loading) is therefore vacuous here rather than
                absent: there is nothing to hide. */}
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
