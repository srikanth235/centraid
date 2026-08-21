// NOTIFICATIONS — the phone's consent surface (#765, spec §2), revamped onto
// the v9 block list.
//
// Agents stage external writes, connections lapse, high-risk acts park,
// republished apps ask for wider scopes, and automations file notices. This
// screen is the one place an owner sees all of it and decides.
//
// The v9 shape is a single BLOCK LIST, not a set of chip-gated views: the head
// of the queue is promoted to a panel (the words are somebody else's, so they
// are quoted, and every fact about where they are going is stated before the
// commit), everything else waiting is a row, and the reference material
// underneath — standing grants, updates, the archive — is sections of rows in
// the same list rather than content hidden behind a filter.
//
// WHAT THE OLD SCREEN DID, AND WHERE IT WENT (nothing was dropped):
//   • the five-way source filter (Needs me / Automations / Agents / Apps /
//     Archived) → the queue chips narrow by what a thing NEEDS, and the
//     notices that are not demands live in `Updates` and `Archived` sections
//     that are always present rather than one filter position away.
//   • `OutboxDecisionCard` → the panel, plus two rows under it carrying the
//     edit form and the always-allow toggle (see `approvals/StagedWrite.tsx`).
//   • the `Reconnect` card → an `Also waiting` row whose verb runs the same
//     in-app OAuth ceremony, with the "stay here until it closes" sentence
//     kept on the row, because leaving the app still breaks the ceremony.
//   • `no-gateway` → the error panel with the pairing sentence and the
//     `Open Settings` way forward. It was never a sixth visual state.
//   • `Loading…` → the skeleton at row geometry. Never a spinner.
//
// The data half is `approvals/useApprovals.ts`; every word is
// `approvals/approvals-model.ts`. This file owns the frame and the sequence.

import React, { useCallback, useMemo, useRef, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";

import EmptyBlock from "../kit/components/EmptyBlock";
import { healthLineFor } from "../kit/components/health-line";
import HealthLine from "../kit/components/HealthLine";
import HomeKey from "../kit/components/HomeKey";
import { Text } from "../kit/components/NativeText";
import NoteBlock from "../kit/components/NoteBlock";
import PanelBlock from "../kit/components/PanelBlock";
import PlaceHeader from "../kit/components/PlaceHeader";
import SkeletonRows from "../kit/components/SkeletonRows";
import TopSafeArea from "../kit/components/TopSafeArea";
import { useTheme } from "../kit/theme";
import type { MobileNotice } from "../lib/gateway";
import { mobileNotificationsDestination } from "../lib/notifications-navigation";
import type { SettingsScreenProps } from "../navigation";
import {
  EMPTY_ACTION,
  EMPTY_BODY,
  EMPTY_TITLE,
  ERROR_BODY,
  ERROR_EYEBROW,
  ERROR_RETRY,
  ERROR_TITLE,
  LOADING_NOTE,
  approvalsHealth,
} from "./approvals/approvals-model";
import { styles } from "./approvals/Approvals.styles";
import Queue from "./approvals/ApprovalsQueue";
import Tail from "./approvals/ApprovalsTail";
import { useApprovals } from "./approvals/useApprovals";
import type { BodyProps, Focus } from "./approvals/view-types";

export default function ApprovalsScreen({
  navigation,
}: SettingsScreenProps<"Approvals">): React.JSX.Element {
  const { colors } = useTheme();
  const page = useApprovals();
  const [focus, setFocus] = useState<Focus>({
    alwaysAllow: false,
    editing: false,
    expandedId: undefined,
    filter: "all",
    selectedItemId: undefined,
  });
  const scroller = useRef<ScrollView | null>(null);
  const grantsY = useRef(0);

  const ink = useMemo(
    () => ({
      error: { color: colors.net },
      safe: { backgroundColor: colors.bg },
    }),
    [colors]
  );

  const patch = useCallback(
    (next: Partial<Focus>) => setFocus((prior) => ({ ...prior, ...next })),
    []
  );

  /** The bar's filled verb. Not a navigation: it drops whatever filter is in
   *  force and puts the head of the queue back in the panel, which is what
   *  "review all of it" means on a page whose content is already all here. */
  const reviewAll = useCallback(() => {
    setFocus({
      alwaysAllow: false,
      editing: false,
      expandedId: undefined,
      filter: "all",
      selectedItemId: undefined,
    });
    scroller.current?.scrollTo({ animated: true, y: 0 });
  }, []);

  const scrollToGrants = useCallback(() => {
    scroller.current?.scrollTo({ animated: true, y: grantsY.current });
  }, []);

  /** Where tapping a notice goes. The alert history is the Gateway page's
   *  Alerts tab — one implementation, reached from both places. */
  const openNotice = useCallback(
    (notice: MobileNotice): void => {
      const parent = navigation.getParent();
      const destination = mobileNotificationsDestination(notice);
      switch (destination.kind) {
        case "automation-thread":
          parent?.navigate("Automations", {
            automationRef: destination.automationRef,
          });
          break;
        case "gateway-alerts":
          parent?.navigate("Insights", { initialTab: "alerts" });
          break;
        case "outbox":
          patch({
            editing: false,
            filter: "all",
            selectedItemId: destination.itemId,
          });
          break;
        case "notifications":
          patch({ filter: "all" });
          break;
      }
    },
    [navigation, patch]
  );

  const health = healthLineFor(page.state, approvalsHealth(page.waiting));
  const showBar = page.state !== "loading";
  const showCommit = showBar && page.state !== "error";

  return (
    <TopSafeArea edges={["top"]} style={[styles.safe, ink.safe]}>
      <View style={styles.page}>
        <View style={styles.head}>
          {/* `goBack`, not a pop to Settings: this cover is also reached from
              a push notification, where Settings is not beneath it. */}
          <HomeKey onPress={() => navigation.goBack()} variant="leave" />
          <View style={styles.headBar}>
            <PlaceHeader
              // The reference's gating: the filled commit is hidden while
              // loading AND while errored; the quiet verb only while loading.
              primary={
                showCommit
                  ? { label: "Review all", onPress: reviewAll }
                  : undefined
              }
              secondary={
                showBar
                  ? {
                      label: "History",
                      onPress: () =>
                        navigation
                          .getParent()
                          ?.navigate("Insights", { initialTab: "alerts" }),
                    }
                  : undefined
              }
              title="Notifications"
            />
          </View>
        </View>
        <ScrollView
          contentContainerStyle={styles.body}
          ref={scroller}
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
          <ApprovalsBody
            focus={focus}
            onGrantsLayout={(y) => {
              grantsY.current = y;
            }}
            onOpenNotice={openNotice}
            onOpenSettings={() => navigation.popTo("Settings")}
            page={page}
            patch={patch}
            reviewGrants={scrollToGrants}
          />
        </ScrollView>
      </View>
      <HealthLine text={health.text} />
    </TopSafeArea>
  );
}

function ApprovalsBody(props: BodyProps): React.JSX.Element {
  const { page } = props;

  if (page.state === "loading")
    return (
      <>
        <SkeletonRows accessibilityLabel="Reading what is waiting on you" />
        <NoteBlock text={LOADING_NOTE} />
      </>
    );

  if (page.state === "error")
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
        // The one way forward a phone that was never paired actually has.
        action2={
          page.load.kind === "error" && page.load.unpaired
            ? { label: "Open Settings", onPress: props.onOpenSettings }
            : undefined
        }
        title={ERROR_TITLE}
        tone="net"
      />
    );

  return (
    <>
      {page.state === "empty" ? (
        <EmptyBlock
          action={{ label: EMPTY_ACTION, onPress: props.reviewGrants }}
          body={EMPTY_BODY}
          routine
          title={EMPTY_TITLE}
        />
      ) : (
        <Queue {...props} />
      )}
      <Tail {...props} />
    </>
  );
}
