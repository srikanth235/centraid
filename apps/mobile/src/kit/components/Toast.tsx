import React, { useSyncExternalStore } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { family, radii, useTheme } from "../theme";

export type ToastTone = "neutral" | "accent" | "danger";

export interface ToastAction {
  label: string;
  onPress: () => void;
}

export interface ToastInput {
  message: string;
  tone?: ToastTone;
  action?: ToastAction;
  durationMs?: number;
}

interface ToastState extends ToastInput {
  id: number;
}

let nextId = 0;
let current: ToastState | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function showToast(input: ToastInput): void {
  if (timer !== undefined) clearTimeout(timer);
  current = { ...input, id: ++nextId };
  emit();
  timer = setTimeout(() => {
    current = undefined;
    timer = undefined;
    emit();
  }, input.durationMs ?? 3_500);
}

export function dismissToast(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  if (!current) return;
  current = undefined;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): ToastState | undefined {
  return current;
}

/** One safe-area-aware, non-blocking news surface for the whole mobile app. */
export default function ToastHost(): React.JSX.Element | null {
  const toast = useSyncExternalStore(subscribe, snapshot, snapshot);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  if (!toast) return null;

  const tone = toast.tone ?? "neutral";
  const accent = tone === "danger" ? colors.danger : colors.accent;
  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <View
        accessibilityLiveRegion="polite"
        accessibilityRole="alert"
        style={[styles.host, { bottom: insets.bottom + 16 }]}
      >
        <View
          style={[
            styles.toast,
            {
              backgroundColor: colors.bgElev,
              borderColor: colors.lineStrong,
              shadowColor: colors.text,
            },
          ]}
        >
          <View style={[styles.dot, { backgroundColor: accent }]} />
          <Text style={[styles.message, { color: colors.text }]}>
            {toast.message}
          </Text>
          {toast.action ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                const action = toast.action;
                dismissToast();
                action?.onPress();
              }}
              style={styles.action}
            >
              <Text style={[styles.actionText, { color: accent }]}>
                {toast.action.label}
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityLabel="Dismiss notification"
            accessibilityRole="button"
            hitSlop={8}
            onPress={dismissToast}
            style={styles.close}
          >
            <Text style={[styles.closeText, { color: colors.textFaint }]}>
              ×
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  action: { marginLeft: 8, paddingVertical: 4 },
  actionText: { fontFamily: family.sansBold, fontSize: 12 },
  close: { marginLeft: 2, padding: 2 },
  closeText: { fontFamily: family.sansRegular, fontSize: 19, lineHeight: 19 },
  dot: { borderRadius: 4, height: 8, width: 8 },
  host: { left: 16, position: "absolute", right: 16 },
  message: {
    flex: 1,
    fontFamily: family.sansMedium,
    fontSize: 13,
    lineHeight: 18,
  },
  toast: {
    alignItems: "center",
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    elevation: 8,
    flexDirection: "row",
    gap: 9,
    minHeight: 48,
    paddingHorizontal: 13,
    paddingVertical: 9,
    shadowOffset: { height: 4, width: 0 },
    shadowOpacity: 0.16,
    shadowRadius: 12,
  },
});
