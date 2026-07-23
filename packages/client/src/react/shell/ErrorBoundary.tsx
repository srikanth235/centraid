// Recoverable React error boundary for the shell root (issue #468 K1).
// Class component required by React's error-boundary contract.

import { Component, type ErrorInfo, type JSX, type ReactNode } from 'react';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional title shown above the message. */
  title?: string;
  /** Called when the user hits "Try again" — lets a host remount the subtree. */
  onReset?: () => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

// Class error boundaries need setState + field state; house style prefers
// functional components elsewhere. (#468)
/* eslint-disable react/display-name, react/no-set-state, react/state-in-constructor, react/jsx-handler-names -- (#468) React error boundaries require a class component */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  static displayName = 'ErrorBoundary';

  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface in the host console; crash-log / SW capture live elsewhere.
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  private handleReset = (): void => {
    this.props.onReset?.();
    this.setState({ error: null });
  };

  override render(): JSX.Element {
    const { error } = this.state;
    if (!error) {
      return <>{this.props.children}</>;
    }
    const title = this.props.title ?? 'Something went wrong';
    return (
      <div
        role="alert"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: 12,
          padding: 24,
          maxWidth: 480,
          margin: '10vh auto',
          fontFamily: 'var(--font-sans, system-ui, sans-serif)',
          color: 'var(--ink, #e8e9ec)',
          background: 'var(--bg-elevated, #1a1d24)',
          border: '1px solid var(--line, #2a2e38)',
          borderRadius: 12,
        }}
      >
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{title}</h1>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: 'var(--ink-2, #a8adb8)' }}>
          {error.message || 'An unexpected error stopped this view.'}
        </p>
        <button
          type="button"
          onClick={this.handleReset}
          style={{
            marginTop: 4,
            padding: '8px 14px',
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--bg, #111)',
            background: 'var(--accent, #3EC8B4)',
            border: 'none',
            borderRadius: 8,
            cursor: 'pointer',
          }}
        >
          Try again
        </button>
      </div>
    );
  }
}
/* eslint-enable react/display-name, react/no-set-state, react/state-in-constructor, react/jsx-handler-names */
