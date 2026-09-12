// ALERTS (#1015 R-NY-2) — Activity's alerts tab: every notice the gateway
// posted, one standing line per source. A notice is news, not a decision, so
// this is where it stands and Needs you never shows one.
//
// A line is one tap target that opens its source — a rule's thread, the queue
// for a write, the machine for a health change — and marks it read on the way.
// A failed rule offers "Try again", which re-runs it. Nothing else: no Mark
// read / Archive pair, because a standing line is rewritten by its source when
// the source recovers, and a line the member can file away before then is a
// problem the member can hide instead of fix.
//
// A VIEW OF THE ACTIVITY PLACE, on Activity's own route, so it takes the
// Activity frame (`usePlaceFrame("stats")`, R-NY-1): pushed over Activity it
// is a sub-page with a back key to Activity and no band; standing on Home (a
// deep link) it is Activity's root and draws the band.
//
// Words live in `alerts-model.ts`. The headline is printed VERBATIM: the
// gateway owes a member sentence for anything it hands a seat to display
// (#1015 R-NY-10), and a seat that rewrites it rewrites the member's own
// words — a rule named "Gateway usage" became "vault host usage".

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet } from "react-native";

import { Text } from "../../kit/components/NativeText";
import RowsBlock from "../../kit/components/RowsBlock";
import type { RowsBlockRow } from "../../kit/components/RowsBlock";
import { SystemPlace } from "../../kit/rooms";
import { spacing, t, useTheme } from "../../kit/theme";
import { runAutomation } from "../../lib/automations";
import {
  getNotifications,
  subscribeMobileNotificationsChanges,
  updateMobileNotice,
} from "../../lib/gateway";
import type { MobileNotice } from "../../lib/gateway";
import { mobileNotificationsDestination } from "../../lib/notifications-navigation";
import type { InsightsScreenProps } from "../../navigation";
import { usePlaceFrame } from "../../screens/home/usePlaceFrame";
import { alertLines } from "./alerts-model";

/** No `message`: what failed is not the member's vocabulary, and the room
 *  says the one true sentence about a read that did not land (S14). `at`
 *  anchors every relative phrase — never a render-time clock read. */
type State =
  | { kind: "loading" }
  | { kind: "ready"; at: number; notices: MobileNotice[] }
  | { kind: "error" };

/** The one line a re-run that did not start gets; the row keeps its verb. */
const RETRY_FAILED = "That rule did not start";

export default function GatewayAlerts(props: {
  navigation: InsightsScreenProps["navigation"];
}): React.JSX.Element {
  const { navigation } = props;
  const frame = usePlaceFrame("stats");
  const { colors } = useTheme();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | undefined>();
  const [retryFailed, setRetryFailed] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const notifications = await getNotifications();
      setState({
        at: Date.now(),
        kind: "ready",
        notices: notifications.notices,
      });
    } catch {
      setState({ kind: "error" });
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    const controller = new AbortController();
    void subscribeMobileNotificationsChanges(
      () => void load(),
      controller.signal
    ).catch(() => undefined);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [load]);

  /** Where a line leads, or nothing: a notice with no screen of its own (an
   *  app's, a received share's) is a line and not a link. */
  const openerFor = useCallback(
    (notice: MobileNotice): (() => void) | undefined => {
      const destination = mobileNotificationsDestination(notice);
      const go = ((): (() => void) | undefined => {
        switch (destination.kind) {
          case "automation-thread":
            return () =>
              navigation.navigate("Automations", {
                automationRef: destination.automationRef,
              });
          case "outbox":
            return () =>
              navigation.navigate("Settings", { screen: "NeedsYou" });
          case "gateway-alerts":
            return () => navigation.navigate("SystemOnPhone");
          case "notifications":
            return undefined;
        }
      })();
      if (!go) return undefined;
      return () => {
        // Opening IS reading. Best-effort: a read mark that does not land
        // must never stand between the member and the source.
        if (notice.readAt === null)
          void updateMobileNotice(notice.noticeId, "read").catch(
            () => undefined
          );
        go();
      };
    },
    [navigation]
  );

  const retry = useCallback(
    (noticeId: string, ref: string): void => {
      setBusy(noticeId);
      setRetryFailed(false);
      void runAutomation(ref)
        .then(load)
        .catch(() => setRetryFailed(true))
        .finally(() => setBusy(undefined));
    },
    [load]
  );

  const rows = useMemo((): RowsBlockRow[] => {
    if (state.kind !== "ready") return [];
    return alertLines(state.notices, state.at).map(({ line, notice }) => {
      const { title } = line;
      const open = openerFor(notice);
      const retryRef = line.retryRef;
      return {
        key: line.key,
        meta: line.meta,
        net: line.net,
        off: busy === line.key,
        sub: line.sub,
        title,
        ...(open ? { onPress: open } : {}),
        ...(retryRef
          ? {
              action: {
                hint: `Try again — ${title}`,
                label: "Try again",
                onPress: () => retry(line.key, retryRef),
              },
            }
          : {}),
      };
    });
  }, [busy, openerFor, retry, state]);

  return (
    <SystemPlace
      empty={
        state.kind === "ready" && rows.length === 0
          ? {
              body: "When a rule does not finish or the system goes down, it shows here until it recovers.",
              routine: true,
              title: "Nothing to report",
            }
          : undefined
      }
      error={
        state.kind === "error"
          ? {
              body: "The alert log is on the home machine, and this phone could not read it.",
              retry: { label: "Try again", onPress: () => void load() },
              title: "Could not read the alerts",
            }
          : undefined
      }
      loading={
        state.kind === "loading" ? { label: "Reading the alerts" } : undefined
      }
      {...frame}
      onRefresh={() => {
        setRefreshing(true);
        void load().finally(() => setRefreshing(false));
      }}
      refreshing={refreshing}
      title="Alerts"
    >
      {retryFailed ? (
        <Text style={[styles.retryFailed, { color: colors.net }]}>
          {RETRY_FAILED}
        </Text>
      ) : null}
      <RowsBlock accessibilityLabel="Alerts" rows={rows} />
    </SystemPlace>
  );
}

const styles = StyleSheet.create({
  // About the tap that just happened, so it sits above the lines it is about.
  retryFailed: { ...t("mono"), paddingBottom: spacing[2] },
});
