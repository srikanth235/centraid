import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, RefreshControl, StyleSheet, View } from "react-native";
import type { ListRenderItemInfo } from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";

import Button from "../../kit/components/Button";
import HomeKey from "../../kit/components/HomeKey";
import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { postStatus } from "../../kit/components/status-line";
import { family, radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { listAutomationTurns, runAutomation } from "../../lib/automations";
import type { AutomationTurnRow } from "../../lib/automations";

type State =
  | { kind: "loading" }
  | { kind: "ready"; turns: AutomationTurnRow[] }
  | { kind: "error"; message: string };

export default function AutomationThread(props: {
  automationRef: string;
  onLeave: () => void;
}): React.JSX.Element {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [running, setRunning] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setState({
        kind: "ready",
        turns: await listAutomationTurns(props.automationRef),
      });
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not load.",
      });
    }
  }, [props.automationRef]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const runNow = (): void => {
    if (running) return;
    setRunning(true);
    void runAutomation(props.automationRef)
      .then(load)
      .catch((error: unknown) =>
        postStatus(
          `Could not run: ${error instanceof Error ? error.message : "Please try again."}`
        )
      )
      .finally(() => setRunning(false));
  };

  const turns = useMemo(
    () => (state.kind === "ready" ? state.turns : []),
    [state]
  );

  const renderTurn = useCallback(
    ({ item }: ListRenderItemInfo<AutomationTurnRow>): React.JSX.Element => (
      <TurnCard turn={item} styles={styles} colors={colors} />
    ),
    [colors, styles]
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <HomeKey variant="leave" onPress={props.onLeave} />
        <View style={styles.headerCopy}>
          <Text style={styles.title}>Automation thread</Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {props.automationRef}
          </Text>
        </View>
        <Button
          label={running ? "Running…" : "Run now"}
          disabled={running}
          onPress={runNow}
          variant="secondary"
        />
      </View>
      <FlatList
        data={turns}
        keyExtractor={turnKey}
        contentContainerStyle={[
          styles.list,
          { paddingBottom: insets.bottom + spacing[5] },
        ]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load().finally(() => setRefreshing(false));
            }}
            tintColor={colors.textFaint}
          />
        }
        ListEmptyComponent={<Empty state={state} styles={styles} />}
        // No getItemLayout and no windowing overrides: `listAutomationTurns`
        // caps the thread at 50 turns, and a card's height varies with the
        // summary wrap and the optional error line, so any fixed height would
        // mis-place cells for no gain on a bounded list.
        renderItem={renderTurn}
      />
    </SafeAreaView>
  );
}

const turnKey = (turn: AutomationTurnRow): string => turn.turnId;

const TurnCard = memo(
  ({
    turn,
    styles,
    colors,
  }: {
    turn: AutomationTurnRow;
    styles: ReturnType<typeof makeStyles>;
    colors: ThemeColors;
  }): React.JSX.Element => (
    <View style={styles.turn}>
      <View style={styles.turnHead}>
        <Icon
          name={turn.ok ? "check-circle" : "alert-circle"}
          size={16}
          color={turn.ok ? colors.accent : colors.danger}
        />
        <Text style={styles.turnTitle}>
          {turn.summary ?? `${turn.triggerKind} turn`}
        </Text>
      </View>
      <Text style={styles.turnMeta}>
        <Text style={[styles.turnMeta, t("mono")]}>
          {new Date(turn.startedAt).toLocaleString()}
        </Text>
        {turn.stepCount === undefined ? null : (
          <>
            {" · "}
            <Text style={[styles.turnMeta, t("mono")]}>
              {turn.stepCount}
            </Text>{" "}
            steps
          </>
        )}
        {turn.toolCount === undefined ? null : (
          <>
            {" · "}
            <Text style={[styles.turnMeta, t("mono")]}>
              {turn.toolCount}
            </Text>{" "}
            tools
          </>
        )}
      </Text>
      {turn.error ? <Text style={styles.turnError}>{turn.error}</Text> : null}
    </View>
  )
);
TurnCard.displayName = "TurnCard";

function Empty(props: {
  state: State;
  styles: ReturnType<typeof makeStyles>;
}): React.JSX.Element {
  if (props.state.kind === "loading")
    return <Text style={props.styles.empty}>Opening the thread…</Text>;
  if (props.state.kind === "error")
    return <Text style={props.styles.empty}>{props.state.message}</Text>;
  return <Text style={props.styles.empty}>No turns in this thread yet.</Text>;
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    empty: {
      ...t("body"),
      color: colors.textFaint,
      paddingVertical: spacing[6],
    },
    header: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing[3],
      paddingHorizontal: spacing[5],
      paddingVertical: spacing[2],
    },
    headerCopy: { flex: 1, minWidth: 0 },
    list: { gap: spacing[3], padding: spacing[5] },
    safe: { backgroundColor: colors.bg, flex: 1 },
    subtitle: { ...t("small"), color: colors.textFaint, marginTop: 2 },
    title: {
      color: colors.text,
      fontFamily: family.displayRegular,
      fontSize: 26,
      letterSpacing: -0.3,
    },
    turn: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: 1,
      padding: spacing[4],
    },
    turnError: { ...t("small"), color: colors.danger, marginTop: spacing[2] },
    turnHead: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing[2],
    },
    turnMeta: { ...t("small"), color: colors.textFaint, marginTop: spacing[2] },
    turnTitle: { ...t("bodyStrong"), color: colors.text, flex: 1 },
  });
