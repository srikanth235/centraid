// NEEDS YOU — the decision queue (#765 spec §2; #1015 R-NY-2): staged writes,
// lapsed connections, parked high-risk acts and scope requests — the things a
// member can decide on the phone, and nothing else. Notices are news, not
// decisions: they stand in Activity's alerts tab. Standing grants are the
// record in Settings → Access. V9 shape = single BLOCK LIST:
//   • chips narrow by what a thing NEEDS, only once the queue outgrows them
//   • staged write = panel + edit row + always-allow row (`StagedWrite.tsx`)
//   • lapsed connection = `Also waiting` row running the OAuth ceremony
//   • `no-gateway` = error panel + pairing sentence + `Open Settings`
// No header verb: the page has no single commit, and Activity is on the band.
// Data half `useApprovals.ts`; words `approvals-model.ts`.

import React, { useCallback, useMemo, useRef, useState } from "react";
import type { ScrollView } from "react-native";

import EmptyBlock from "../kit/components/EmptyBlock";
import { healthLineFor } from "../kit/components/health-line";
import HealthLine from "../kit/components/HealthLine";
import { Text } from "../kit/components/NativeText";
import { SystemPlace } from "../kit/rooms";
import { useTheme } from "../kit/theme";
import type { SettingsScreenProps } from "../navigation";
import {
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

  const health = healthLineFor(page.state, approvalsHealth());

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
      title={SHELL_TITLES.alerts}
    >
      {page.actionError ? (
        <Text style={[styles.actionError, ink.error]}>{page.actionError}</Text>
      ) : null}
      <ApprovalsBody focus={focus} page={page} patch={patch} />
    </SystemPlace>
  );
}

/** The queue, or the queue's empty. Loading and error are the ROOM's states
 *  (#1015, Wave 2) — a body that drew them could paint an empty state over a
 *  read that failed, which is what `RoomBody`'s fixed order stops. The empty
 *  carries no verb: the one it had scrolled to a standing-grants tail that
 *  left this page for Settings → Access (R-NY-2). */
function ApprovalsBody(props: BodyProps): React.JSX.Element {
  return props.page.state === "empty" ? (
    <EmptyBlock body={EMPTY_BODY} routine title={EMPTY_TITLE} />
  ) : (
    <Queue {...props} />
  );
}
