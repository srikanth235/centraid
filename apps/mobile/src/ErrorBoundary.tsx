import React, { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { Appearance, View, Pressable, StyleSheet } from "react-native";

import { toNativeTheme } from "@centraid/design";

import { Text } from "./kit/components/NativeText";
import { radii, t } from "./kit/theme";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/* oxlint-disable react/no-set-state, react/state-in-constructor -- (#468) React error boundaries require a class component */
export default class ErrorBoundary extends Component<Props, State> {
  static readonly displayName = "ErrorBoundary";

  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  private handleReset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const scheme = Appearance.getColorScheme() === "dark" ? "dark" : "light";
    const { colors } = toNativeTheme(scheme);
    return (
      <View
        style={[styles.wrap, { backgroundColor: colors.bg }]}
        accessibilityRole="alert"
      >
        <Text style={[styles.title, { color: colors.text }]}>
          Something went wrong
        </Text>
        <Text style={[styles.body, { color: colors.textSoft }]}>
          {error.message || "An unexpected error stopped this view."}
        </Text>
        <Pressable
          onPress={this.handleReset}
          style={[styles.button, { backgroundColor: colors.accentFill }]}
          accessibilityRole="button"
        >
          <Text style={[styles.buttonText, { color: colors.textInv }]}>
            Try again
          </Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    justifyContent: "center",
    padding: 24,
  },
  title: {
    ...t("title"),
    marginBottom: 8,
  },
  body: {
    ...t("body"),
    marginBottom: 16,
  },
  button: {
    alignSelf: "flex-start",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radii.md,
  },
  buttonText: {
    ...t("bodyStrong"),
  },
});
/* oxlint-enable react/no-set-state, react/state-in-constructor */
