import React, { useEffect, useMemo, useRef } from "react";
import {
  ActionSheetIOS,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";

import { borders, radii, spacing, t, useTheme } from "../theme";
import type { ThemeColors } from "../theme";
import { Text } from "./NativeText";

export interface SheetOption {
  id: string;
  label: string;
  /** Secondary line — e.g. a runner's readiness hint. */
  detail?: string;
  /** Listed but not choosable (a runner that failed its preflight). */
  disabled?: boolean;
}

export interface OptionSheetProps {
  visible: boolean;
  title: string;
  options: SheetOption[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}

/**
 * A single-choice list presented the way each platform presents one: the system
 * action sheet on iOS, a bottom sheet built from RN core `Modal` on Android
 * (RN's `Alert` renders at most three buttons there, so it cannot list agents).
 *
 * A list, never a tap-to-cycle chip (#567 D12): cycling walks the member
 * through every dead runner — one preflight each — to reach the one they want.
 */
export default function OptionSheet({
  visible,
  title,
  options,
  selectedId,
  onSelect,
  onClose,
}: OptionSheetProps): React.JSX.Element | null {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const ios = Platform.OS === "ios";
  // The iOS sheet is imperative and fire-once: read the current props through a
  // ref so a re-render mid-sheet cannot stack a second one.
  const latest = useRef({ title, options, onSelect, onClose });
  // Declared BEFORE the presenting effect, so on any commit the sheet reads
  // this render's props (effects run in declaration order).
  useEffect(() => {
    latest.current = { title, options, onSelect, onClose };
  });

  useEffect(() => {
    if (!visible || !ios) return;
    const current = latest.current;
    const labels = current.options.map((option) =>
      option.detail ? `${option.label} — ${option.detail}` : option.label
    );
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: current.title,
        options: [...labels, "Cancel"],
        cancelButtonIndex: labels.length,
        disabledButtonIndices: current.options.flatMap((option, index) =>
          option.disabled ? [index] : []
        ),
      },
      (index) => {
        current.onClose();
        const chosen = current.options[index];
        if (chosen && !chosen.disabled) current.onSelect(chosen.id);
      }
    );
  }, [visible, ios]);

  if (ios || !visible) return null;
  return (
    <Modal transparent visible animationType="slide" onRequestClose={onClose}>
      <Pressable
        accessibilityLabel="Dismiss"
        style={styles.scrim}
        onPress={onClose}
      />
      <View style={styles.sheet}>
        <Text style={styles.title}>{title}</Text>
        <ScrollView style={styles.list}>
          {options.map((option) => (
            <Pressable
              key={option.id}
              accessibilityRole="button"
              accessibilityState={{
                disabled: option.disabled === true,
                selected: option.id === selectedId,
              }}
              disabled={option.disabled}
              onPress={() => {
                onClose();
                onSelect(option.id);
              }}
              style={styles.row}
            >
              <Text
                style={[
                  styles.rowLabel,
                  option.disabled === true && styles.rowDisabled,
                ]}
              >
                {option.label}
                {option.id === selectedId ? " ✓" : ""}
              </Text>
              {option.detail ? (
                <Text style={styles.rowDetail}>{option.detail}</Text>
              ) : null}
            </Pressable>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    list: { maxHeight: 340 },
    row: {
      borderBottomColor: colors.line,
      borderBottomWidth: borders.hairline,
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[3],
    },
    rowDetail: { ...t("control"), color: colors.textFaint },
    rowDisabled: { color: colors.textFaint },
    rowLabel: { ...t("body"), color: colors.text },
    scrim: { backgroundColor: colors.scrim, flex: 1 },
    sheet: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderTopLeftRadius: radii.lg,
      borderTopRightRadius: radii.lg,
      borderWidth: borders.hairline,
      paddingBottom: spacing[6],
      paddingTop: spacing[4],
    },
    title: {
      ...t("small"),
      color: colors.textSoft,
      paddingBottom: spacing[2],
      paddingHorizontal: spacing[4],
    },
  });
