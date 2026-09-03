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
  detail?: string;
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
  const latest = useRef({ title, options, onSelect, onClose });
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
