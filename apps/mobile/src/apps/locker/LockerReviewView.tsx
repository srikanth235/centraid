// REVIEW — `locker/watch` (README-Locker §5, "Review"; §6).
//
// TWO REGISTERS, and the second one is the point. *Needs attention* is what
// this product can honestly check and what it found; *Checked, and cannot be
// checked* is every check that could not run, each with its reason and its
// gap tag — listed rather than left out, because a review surface that
// silently omits what it cannot do is a review surface that overstates itself.
//
// ALL CLEAR IS A DESIGNED STATE, not an empty one: it says what was checked
// and over how many items. Both registers come from `review-model.ts`, which
// reads the same `matchesCheck` derivation the list's verdict lens uses — so
// pressing a count can never open a lens over a different set.
//
// WINDOWED (#883 C4): a verdict can hold it all.
import React, { useMemo, useState } from "react";
import { FlatList, StyleSheet, View } from "react-native";
import type { ListRenderItemInfo } from "react-native";

import { reviewRegister } from "@centraid/blueprints/apps/locker/review-model";
import {
  ALL_CLEAR,
  REVIEW_ATTENTION,
  REVIEW_ITEMS,
  REVIEW_ITEMS_META,
  REVIEW_NOTHING,
  REVIEW_NOTHING_BODY,
  REVIEW_SHOW_THEM,
  REVIEW_UNRUNNABLE,
  REVIEW_UNRUNNABLE_META,
  allClearBody,
  verdictMeta,
} from "@centraid/blueprints/apps/locker/route-copy";
import type {
  CheckKey,
  LockerRow as LockerRowData,
} from "@centraid/blueprints/apps/locker/types";

import EmptyBlock from "../../kit/components/EmptyBlock";
import { Text } from "../../kit/components/NativeText";
import SectionBlock from "../../kit/components/SectionBlock";
import SkeletonRows from "../../kit/components/SkeletonRows";
import { borders, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { LockerScreenState } from "./locker-view-model";
import LockerNotice from "./LockerNotice";
import { LockerRow, lockerRowKey } from "./LockerRow";

export interface LockerReviewViewProps {
  rows: readonly LockerRowData[];
  state: LockerScreenState;
  pending: number;
  lastReadAt: string | null;
  onOpen: (row: LockerRowData) => void;
}

export default function LockerReviewView(
  props: LockerReviewViewProps
): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const register = useMemo(() => reviewRegister(props.rows), [props.rows]);
  const [lens, setLens] = useState<CheckKey | null>(null);

  if (props.state === "loading") {
    return (
      <View style={styles.page}>
        <SkeletonRows accessibilityLabel="Running the review" />
      </View>
    );
  }

  if (props.rows.length === 0) {
    return (
      <View style={styles.page}>
        <EmptyBlock title={REVIEW_NOTHING} body={REVIEW_NOTHING_BODY} routine />
      </View>
    );
  }

  const shown = lens
    ? (register.attention.find((row) => row.key === lens)?.items ?? [])
    : register.items;

  const renderItem = ({
    item,
  }: ListRenderItemInfo<LockerRowData>): React.JSX.Element => (
    <LockerRow row={item} onOpen={props.onOpen} />
  );

  const head = (
    <View>
      <LockerNotice
        state={props.state}
        pending={props.pending}
        lastReadAt={props.lastReadAt}
      />

      {register.allClear ? (
        <View style={styles.block}>
          <SectionBlock label={ALL_CLEAR} />
          <Text style={styles.body}>
            {allClearBody(props.rows.length, register.ran.length)}
          </Text>
        </View>
      ) : (
        <View style={styles.block}>
          <SectionBlock
            label={REVIEW_ATTENTION}
            meta={verdictMeta(register.verdicts, register.ran.length)}
          />
          {register.attention.map((verdict) => (
            <View key={verdict.key} style={styles.verdict}>
              <View style={styles.verdictHead}>
                <Text
                  style={[
                    styles.verdictLabel,
                    verdict.tone === "net" ? { color: colors.net } : undefined,
                  ]}
                >
                  {verdict.label}
                </Text>
                <Text style={styles.count}>{String(verdict.count)}</Text>
                <Text
                  accessibilityRole="button"
                  accessibilityLabel={`${REVIEW_SHOW_THEM}. ${verdict.label}`}
                  onPress={() =>
                    setLens((current) =>
                      current === verdict.key ? null : verdict.key
                    )
                  }
                  style={styles.showThem}
                >
                  {REVIEW_SHOW_THEM}
                </Text>
              </View>
              <Text style={styles.why}>{verdict.why}</Text>
            </View>
          ))}
        </View>
      )}

      <View style={styles.block}>
        <SectionBlock label={REVIEW_UNRUNNABLE} meta={REVIEW_UNRUNNABLE_META} />
        {register.unrunnable.map((check) => (
          <View key={check.key} style={styles.verdict}>
            <Text style={styles.verdictLabel}>{check.label}</Text>
            <Text style={styles.why}>{check.why}</Text>
          </View>
        ))}
      </View>

      {shown.length > 0 ? (
        <View style={styles.block}>
          <SectionBlock label={REVIEW_ITEMS} meta={REVIEW_ITEMS_META} />
        </View>
      ) : null}
    </View>
  );

  return (
    <FlatList
      contentContainerStyle={styles.scroll}
      data={shown}
      keyExtractor={lockerRowKey}
      ListHeaderComponent={head}
      initialNumToRender={12}
      maxToRenderPerBatch={12}
      renderItem={renderItem}
      windowSize={7}
    />
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    block: { paddingTop: spacing[3] },
    body: { ...t("small"), color: colors.textSoft, padding: spacing[4] },
    count: { ...t("mono"), color: colors.textSoft },
    page: { flex: 1, padding: spacing[4] },
    scroll: { paddingBottom: spacing[6] },
    showThem: { ...t("control"), color: colors.text },
    verdict: {
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      gap: spacing[1],
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[3],
    },
    verdictHead: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing[3],
    },
    verdictLabel: { ...t("smallStrong"), color: colors.text, flex: 1 },
    why: { ...t("mono"), color: colors.textFaint },
  });
