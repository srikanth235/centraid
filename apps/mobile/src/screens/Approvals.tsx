// NOTIFICATIONS — consent surface (#765, spec §2): staged writes, lapsed
// connections, parked high-risk acts, scope requests, automation notices —
// the one place an owner sees all of it and decides. V9 shape = single BLOCK
// LIST; nothing behind a filter, nothing dropped:
//   • chips narrow by what a thing NEEDS; non-demands sit in always-present
//     `Updates`/`Archived` sections
//   • staged write = panel + edit row + always-allow row (`StagedWrite.tsx`)
//   • lapsed connection = `Also waiting` row running the OAuth ceremony
//   • `no-gateway` = error panel + pairing sentence + `Open Settings`
// Data half `useApprovals.ts`; words `approvals-model.ts`.

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

  /** Not navigation: drops the active filter and re-promotes the queue head. */
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

  /** Alert history is the Gateway page's Alerts tab — one implementation, two entries. */
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
          {/* Not pop-to-Settings: also reached from push notifications, where Settings isn't beneath. */}
          <HomeKey onPress={() => navigation.goBack()} variant="leave" />
          <View style={styles.headBar}>
            <PlaceHeader
              // Filled commit hidden while loading AND errored; quiet verb only while loading.
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
        // The one way forward an unpaired phone has.
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
