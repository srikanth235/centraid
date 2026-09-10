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
import type { ScrollView } from "react-native";

import EmptyBlock from "../kit/components/EmptyBlock";
import { healthLineFor } from "../kit/components/health-line";
import HealthLine from "../kit/components/HealthLine";
import { Text } from "../kit/components/NativeText";
import { SystemPlace } from "../kit/rooms";
import { useTheme } from "../kit/theme";
import type { MobileNotice } from "../lib/gateway";
import { mobileNotificationsDestination } from "../lib/notifications-navigation";
import type { SettingsScreenProps } from "../navigation";
import {
  EMPTY_ACTION,
  EMPTY_BODY,
  EMPTY_TITLE,
  ERROR_BODY,
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
import { SHELL_TITLES } from "./shell-copy";

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
    <SystemPlace
      bodyRef={scroller}
      error={
        page.state === "error"
          ? {
              body: ERROR_BODY,
              ...(page.load.kind === "error" && page.load.unpaired
                ? { detail: page.load.reason }
                : {}),
              retry: { label: ERROR_RETRY, onPress: page.retry },
              // The one way forward an unpaired phone has.
              ...(page.load.kind === "error" && page.load.unpaired
                ? {
                    secondary: {
                      label: "Open Settings",
                      onPress: () => navigation.popTo("SettingsHome"),
                    },
                  }
                : {}),
              title: ERROR_TITLE,
            }
          : undefined
      }
      footer={<HealthLine text={health.text} />}
      loading={
        page.state === "loading"
          ? { label: "Reading what is waiting on you", note: LOADING_NOTE }
          : undefined
      }
      // Not pop-to-Settings: also reached from push notifications, where
      // Settings is not beneath.
      onHome={() => navigation.goBack()}
      onRefresh={() => void page.refresh()}
      refreshing={page.refreshing}
      // Filled commit hidden while loading AND errored; quiet verb only while
      // loading.
      {...(showCommit
        ? { action: { label: "Review all", onPress: reviewAll } }
        : {})}
      {...(showBar
        ? {
            secondary: {
              label: "History",
              onPress: () =>
                navigation
                  .getParent()
                  ?.navigate("Insights", { initialTab: "alerts" }),
            },
          }
        : {})}
      title={SHELL_TITLES.alerts}
    >
      {page.actionError ? (
        <Text style={[styles.actionError, ink.error]}>{page.actionError}</Text>
      ) : null}
      <ApprovalsBody
        focus={focus}
        reviewGrants={scrollToGrants}
        onGrantsLayout={(y) => {
          grantsY.current = y;
        }}
        onOpenNotice={openNotice}
        page={page}
        patch={patch}
      />
    </SystemPlace>
  );
}

/** The queue and its tail. Loading and error are the ROOM's states now (#1015,
 *  Wave 2) — a body that drew them could paint an empty state over a read that
 *  failed, which is what `RoomBody`'s fixed order stops. The EMPTY stays here:
 *  it is the queue that is empty, and the standing grants below it are still
 *  the record this page exists to show. */
function ApprovalsBody(props: BodyProps): React.JSX.Element {
  return (
    <>
      {props.page.state === "empty" ? (
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
