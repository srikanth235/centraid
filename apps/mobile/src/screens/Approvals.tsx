import * as WebBrowser from "expo-web-browser";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import OutboxDecisionCard from "../components/OutboxDecisionCard";
import Button from "../kit/components/Button";
import Icon from "../kit/components/Icon";
import { radii, spacing, t, useTheme } from "../kit/theme";
import type { ThemeColors } from "../kit/theme";
import {
  ASSIST_RETURN_URL,
  classifyAuthSession,
  reconnectFailureMessage,
} from "../lib/connection-reauth";
import {
  describeInvocationInput,
  describeScopes,
} from "../lib/decision-detail";
import {
  beginNotificationsConnectionAuthorization,
  completeNotificationsConnectionAuthorization,
  confirmParked,
  decideNotificationsOutbox,
  decideNotificationsScope,
  GatewayError,
  getNotifications,
  resolveGatewayBase,
  subscribeMobileNotificationsChanges,
  updateMobileNotice,
} from "../lib/gateway";
import type { MobileNotifications, MobileNotice } from "../lib/gateway";
import { requestNotificationPermission } from "../lib/notifications-core";
import { mobileNotificationsDestination } from "../lib/notifications-navigation";
import { registerReplicaPushWake } from "../lib/replica/background-sync";
import type { SettingsScreenProps } from "../navigation";

type NotificationsState =
  | { kind: "loading" }
  | { kind: "no-gateway" }
  | { kind: "ready"; notifications: MobileNotifications }
  | { kind: "error"; message: string };

type Filter = "needs" | "automations" | "agents" | "apps" | "archived";

async function loadNotifications(
  setState: (next: NotificationsState) => void
): Promise<void> {
  try {
    if (!(await resolveGatewayBase())) {
      setState({ kind: "no-gateway" });
      return;
    }
    setState({ kind: "ready", notifications: await getNotifications(true) });
  } catch (error) {
    setState({
      kind: "error",
      message:
        error instanceof GatewayError || error instanceof Error
          ? error.message
          : "Could not load Notifications.",
    });
  }
}

export default function ApprovalsScreen({
  navigation,
}: SettingsScreenProps<"Approvals">): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [state, setState] = useState<NotificationsState>({ kind: "loading" });
  const [filter, setFilter] = useState<Filter>("needs");
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();
  const [focusedOutboxId, setFocusedOutboxId] = useState<string | undefined>();

  useEffect(() => {
    void loadNotifications(setState);
    void requestNotificationPermission()
      .then(async (granted) => {
        if (!granted) return;
        const base = await resolveGatewayBase();
        if (base) await registerReplicaPushWake(base);
      })
      .catch(() => undefined);
    const controller = new AbortController();
    void subscribeMobileNotificationsChanges(
      () => void loadNotifications(setState),
      controller.signal
    ).catch(() => undefined);
    const timer = setInterval(() => void loadNotifications(setState), 60_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    setActionError(undefined);
    await loadNotifications(setState);
    setRefreshing(false);
  }, []);

  const act = useCallback(
    async (id: string, action: () => Promise<void>): Promise<void> => {
      setBusy(id);
      setActionError(undefined);
      try {
        await action();
        await loadNotifications(setState);
      } catch (error) {
        setActionError(
          error instanceof Error ? error.message : "Could not save that action."
        );
      } finally {
        setBusy(undefined);
      }
    },
    []
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.bar}>
        <Pressable
          onPress={() => navigation.goBack()}
          hitSlop={12}
          accessibilityLabel="Back"
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.6 }]}
        >
          <Icon
            name="ArrowLeft"
            size={20}
            color={colors.ink}
            strokeWidth={1.75}
          />
        </Pressable>
        <Text style={styles.title}>Notifications</Text>
        <View style={styles.barSpacer} />
      </View>
      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            tintColor={colors.ink3}
          />
        }
      >
        <FilterBar value={filter} onChange={setFilter} styles={styles} />
        {actionError ? (
          <Text style={styles.actionError}>{actionError}</Text>
        ) : null}
        {renderBody({
          state,
          filter,
          busy,
          styles,
          openSettings: () => navigation.navigate("Settings"),
          reconnectConnection: (connectionId) =>
            act(connectionId, async () => {
              const authUrl =
                await beginNotificationsConnectionAuthorization(connectionId);
              // An IN-APP auth session, never `Linking.openURL`: the host app
              // must stay active so the phone-local tunnel proxy keeps serving
              // the gateway's own OAuth callback, and so the Assist return
              // `centraid://oauth/finish` resolves back into THIS process (the
              // ceremony is bound to this client session + device). See
              // lib/connection-reauth.ts.
              const outcome = classifyAuthSession(
                await WebBrowser.openAuthSessionAsync(
                  authUrl,
                  ASSIST_RETURN_URL
                )
              );
              const failure = reconnectFailureMessage(outcome);
              if (failure) throw new Error(failure);
              if (outcome.kind === "assist-handoff")
                await completeNotificationsConnectionAuthorization(
                  outcome.handoff
                );
              // `closed` needs nothing: a BYO ceremony finishes at the
              // gateway's callback, and `act` re-reads Notifications either way —
              // an authorized connection stops being a decision.
            }),
          openNotice: (notice) => {
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
                setFilter("needs");
                setFocusedOutboxId(destination.itemId);
                break;
              case "app":
                parent?.navigate("AppDetail", {
                  appId: destination.appId,
                });
                break;
              case "notifications":
                setFilter("needs");
                break;
            }
          },
          focusedOutboxId,
          act,
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

function FilterBar({
  value,
  onChange,
  styles,
}: {
  value: Filter;
  onChange: (next: Filter) => void;
  styles: ReturnType<typeof makeStyles>;
}): React.JSX.Element {
  const values: Array<[Filter, string]> = [
    ["needs", "Needs me"],
    ["automations", "Automations"],
    ["agents", "Agents"],
    ["apps", "Apps"],
    ["archived", "Archived"],
  ];
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.filters}
    >
      {values.map(([id, label]) => (
        <Pressable
          key={id}
          onPress={() => onChange(id)}
          style={[styles.filter, value === id && styles.filterActive]}
        >
          <Text
            style={[styles.filterText, value === id && styles.filterTextActive]}
          >
            {label}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function renderBody(input: {
  state: NotificationsState;
  filter: Filter;
  busy: string | undefined;
  styles: ReturnType<typeof makeStyles>;
  openSettings: () => void;
  reconnectConnection: (connectionId: string) => Promise<void>;
  openNotice: (notice: MobileNotice) => void;
  focusedOutboxId: string | undefined;
  act: (id: string, action: () => Promise<void>) => Promise<void>;
}): React.JSX.Element {
  const {
    state,
    filter,
    busy,
    styles,
    openSettings,
    reconnectConnection,
    openNotice,
    focusedOutboxId,
    act,
  } = input;
  if (state.kind === "loading")
    return <Text style={styles.emptyCopy}>Loading…</Text>;
  if (state.kind === "no-gateway") {
    return (
      <View>
        <Text style={styles.emptyTitle}>Not connected.</Text>
        <Text style={styles.emptyCopy}>
          Pair with your desktop to open Notifications.
        </Text>
        <View style={styles.emptyAction}>
          <Button
            label="Open Settings"
            icon="Settings"
            variant="soft"
            onPress={openSettings}
          />
        </View>
      </View>
    );
  }
  if (state.kind === "error") {
    return (
      <View>
        <Text style={styles.emptyTitle}>Could not load Notifications.</Text>
        <Text style={styles.emptyCopy}>{state.message}</Text>
        <Text style={styles.emptyHint}>Pull to refresh to retry.</Text>
      </View>
    );
  }
  const { decisions, notices } = state.notifications;
  const activeNotices = notices.filter((notice) => notice.archivedAt === null);
  const shownNotices =
    filter === "archived"
      ? notices.filter((notice) => notice.archivedAt !== null)
      : filter === "needs"
        ? activeNotices
        : activeNotices.filter(
            (notice) =>
              notice.detail.sourceType ===
              (filter === "automations"
                ? "automation"
                : filter === "agents"
                  ? "agent"
                  : "app")
          );
  const hasDecisions = filter === "needs" && decisions.count > 0;
  if (!hasDecisions && shownNotices.length === 0) {
    return <Text style={styles.emptyCopy}>Nothing in this view.</Text>;
  }
  return (
    <View style={styles.list}>
      {filter === "needs"
        ? decisions.outbox.map((row) => (
            <OutboxDecisionCard
              key={`${row.itemId}:${focusedOutboxId === row.itemId}`}
              row={row}
              busy={busy === row.itemId}
              focused={focusedOutboxId === row.itemId}
              onApprove={(artifact, alwaysAllow) =>
                act(row.itemId, () =>
                  decideNotificationsOutbox(row.itemId, "approve", {
                    ...(artifact ? { artifact } : {}),
                    alwaysAllow,
                  })
                )
              }
              onDeny={() =>
                act(row.itemId, () =>
                  decideNotificationsOutbox(row.itemId, "discard")
                )
              }
            />
          ))
        : null}
      {filter === "needs"
        ? decisions.parked.map((row) => (
            <DecisionCard
              key={row.invocationId}
              title={row.command}
              detail={`${row.caller ?? row.callerKind} · ${formatWhen(row.parkedAt)}`}
              extra={describeInvocationInput(row.input)}
              busy={busy === row.invocationId}
              styles={styles}
              onApprove={() =>
                act(row.invocationId, () =>
                  confirmParked(row.invocationId, true)
                )
              }
              onDeny={() =>
                act(row.invocationId, () =>
                  confirmParked(row.invocationId, false)
                )
              }
            />
          ))
        : null}
      {filter === "needs"
        ? decisions.scopeRequests.map((row) => (
            <DecisionCard
              key={row.requestId}
              title={`${row.appId} requests access`}
              detail={row.purpose}
              extra={describeScopes(row.scopes)}
              busy={busy === row.requestId}
              styles={styles}
              onApprove={() =>
                act(row.requestId, () =>
                  decideNotificationsScope(row.requestId, true)
                )
              }
              onDeny={() =>
                act(row.requestId, () =>
                  decideNotificationsScope(row.requestId, false)
                )
              }
            />
          ))
        : null}
      {filter === "needs"
        ? decisions.needsAuth.map((row) => (
            <View key={row.connectionId} style={styles.card}>
              <Text style={styles.cardTitle}>
                {row.label} needs reconnection
              </Text>
              <Text style={styles.cardDetail}>{row.note ?? row.kind}</Text>
              {/*
                Says where the flow finishes, because it finishes INSIDE
                Centraid: the in-app browser keeps this app active, which is
                what keeps the gateway reachable. Leaving for another app
                breaks the ceremony, so the card asks the owner not to.
              */}
              <Text style={styles.cardExtra}>
                Opens a secure browser inside Centraid — stay here until it
                closes.
              </Text>
              <View style={styles.cardActions}>
                <Button
                  label={busy === row.connectionId ? "Opening…" : "Reconnect"}
                  variant="soft"
                  disabled={busy === row.connectionId}
                  onPress={() => void reconnectConnection(row.connectionId)}
                  style={styles.cardBtn}
                />
              </View>
            </View>
          ))
        : null}
      {shownNotices.map((notice) => (
        <NoticeCard
          key={notice.noticeId}
          row={notice}
          busy={busy === notice.noticeId}
          styles={styles}
          onOpen={() => openNotice(notice)}
          onRead={() =>
            act(notice.noticeId, () =>
              updateMobileNotice(notice.noticeId, "read")
            )
          }
          onArchive={() =>
            act(notice.noticeId, () =>
              updateMobileNotice(notice.noticeId, "archive")
            )
          }
        />
      ))}
    </View>
  );
}

function DecisionCard(props: {
  title: string;
  detail: string;
  /**
   * The consent-relevant body: what is actually being granted (scopes) or
   * executed (invocation input). Web shows both; a phone card that omits them
   * asks the owner to approve table-level writes sight-unseen (#647 review).
   */
  extra?: string;
  busy: boolean;
  styles: ReturnType<typeof makeStyles>;
  onApprove: () => Promise<void>;
  onDeny: () => Promise<void>;
}): React.JSX.Element {
  return (
    <View style={props.styles.card}>
      <Text style={props.styles.cardTitle}>{props.title}</Text>
      <Text style={props.styles.cardDetail}>{props.detail}</Text>
      {props.extra ? (
        <Text style={props.styles.cardExtra} numberOfLines={4}>
          {props.extra}
        </Text>
      ) : null}
      <View style={props.styles.cardActions}>
        <Button
          label="Approve"
          icon="Check"
          disabled={props.busy}
          onPress={() => void props.onApprove()}
          style={props.styles.cardBtn}
        />
        <Button
          label="Deny"
          icon="X"
          variant="soft"
          disabled={props.busy}
          onPress={() => void props.onDeny()}
          style={props.styles.cardBtn}
        />
      </View>
    </View>
  );
}

function NoticeCard(props: {
  row: MobileNotice;
  busy: boolean;
  styles: ReturnType<typeof makeStyles>;
  onOpen: () => void;
  onRead: () => Promise<void>;
  onArchive: () => Promise<void>;
}): React.JSX.Element {
  const { row, styles } = props;
  return (
    <View style={[styles.card, row.readAt === null && styles.unreadCard]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${row.headline}`}
        onPress={props.onOpen}
      >
        <Text style={styles.cardTitle}>
          {row.headline}
          {row.count > 1 ? ` ×${row.count}` : ""}
        </Text>
        <Text style={styles.cardDetail}>
          {row.kind.replaceAll("-", " ")} · {formatWhen(row.lastAt)}
        </Text>
      </Pressable>
      {row.archivedAt === null ? (
        <View style={styles.cardActions}>
          {row.readAt === null ? (
            <Button
              label="Mark read"
              variant="soft"
              disabled={props.busy}
              onPress={() => void props.onRead()}
              style={styles.cardBtn}
            />
          ) : null}
          <Button
            label="Archive"
            variant="soft"
            disabled={props.busy}
            onPress={() => void props.onArchive()}
            style={styles.cardBtn}
          />
        </View>
      ) : null}
    </View>
  );
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    actionError: {
      ...t("small"),
      color: colors.danger,
      marginBottom: spacing[3],
    },
    backBtn: {
      alignItems: "center",
      height: 36,
      justifyContent: "center",
      width: 36,
    },
    bar: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
      paddingHorizontal: 14,
      paddingVertical: spacing[2],
    },
    barSpacer: { width: 36 },
    body: { padding: spacing[5] },
    card: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: 1,
      padding: spacing[4],
    },
    unreadCard: { borderColor: colors.accent, borderLeftWidth: 3 },
    cardActions: {
      flexDirection: "row",
      gap: spacing[3],
      marginTop: spacing[3],
    },
    cardBtn: { flex: 1 },
    cardDetail: { ...t("small"), color: colors.ink3, marginTop: 3 },
    cardExtra: { ...t("small"), color: colors.ink2, marginTop: spacing[2] },
    cardTitle: { ...t("bodyStrong"), color: colors.ink },
    emptyAction: { alignSelf: "stretch", marginTop: spacing[4] },
    emptyCopy: { ...t("body"), color: colors.ink2 },
    emptyHint: { ...t("small"), color: colors.ink3, marginTop: spacing[2] },
    emptyTitle: { ...t("title"), color: colors.ink, marginBottom: spacing[2] },
    filter: {
      borderColor: colors.line,
      borderRadius: 999,
      borderWidth: 1,
      paddingHorizontal: spacing[3],
      paddingVertical: spacing[2],
    },
    filterActive: {
      backgroundColor: colors.surface2,
      borderColor: colors.accent,
    },
    filterText: { ...t("small"), color: colors.ink3 },
    filterTextActive: { color: colors.ink },
    filters: { gap: spacing[2], paddingBottom: spacing[4] },
    list: { gap: spacing[3] },
    safe: { backgroundColor: colors.bg, flex: 1 },
    title: { ...t("title"), color: colors.ink },
  });
