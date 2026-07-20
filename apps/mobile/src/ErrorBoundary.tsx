// React Native error boundary (issue #468 K1) — class component required.
import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/* eslint-disable react/no-set-state, react/state-in-constructor -- (#468) React error boundaries require a class component */
export default class ErrorBoundary extends Component<Props, State> {
  static displayName = 'ErrorBoundary';

  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  private handleReset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <View style={styles.wrap} accessibilityRole="alert">
        <Text style={styles.title}>Something went wrong</Text>
        <Text style={styles.body}>{error.message || 'An unexpected error stopped this view.'}</Text>
        <Pressable onPress={this.handleReset} style={styles.button} accessibilityRole="button">
          <Text style={styles.buttonText}>Try again</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#111317',
  },
  title: {
    color: '#e8e9ec',
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
  },
  body: {
    color: '#a8adb8',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 16,
  },
  button: {
    alignSelf: 'flex-start',
    backgroundColor: '#3EC8B4',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
  },
  buttonText: {
    color: '#111',
    fontWeight: '600',
    fontSize: 13,
  },
});
/* eslint-enable react/no-set-state, react/state-in-constructor */
