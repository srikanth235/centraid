import { useState, type JSX } from 'react';
import OnboardingScreen, {
  type OnboardingCompleteInput,
  type OnboardingPath,
} from './OnboardingScreen.js';
import { isWebHost } from '../host-platform.js';
import styles from './RecoverScreen.module.css';

/**
 * First run branches on PLATFORM, not on gateway state (issue #603).
 *
 * There is no founding ceremony and no "uninitialized" gateway any more: a
 * fresh gateway founds "Shared" + "Personal" at construction, so the only
 * question left is which gateway this device should talk to.
 *
 *   - Desktop (Electron) can answer two ways, so it gets a chooser: start a
 *     fresh gateway on this Mac, or join one that already exists with a pair
 *     ticket.
 *   - Web (PWA) can only ever join — there is no gateway to start inside a
 *     browser tab — so it renders the ticket path directly, with no chooser
 *     and no probe.
 *
 * Both paths end at the same profile step (docs/platform-gating.md: presentation
 * branch, never an auth branch).
 */
export interface FirstRunGateProps {
  /** Fresh path completion (identity + connected gateway) — boot writes the
   *  profile + onboarding stamp and swaps in the app. */
  onOnboardingComplete: (input: OnboardingCompleteInput) => Promise<void> | void;
  /** Override the platform decision. Defaults to `isWebHost()`. */
  host?: 'desktop' | 'web';
}

export default function FirstRunGate({
  onOnboardingComplete,
  host = isWebHost() ? 'web' : 'desktop',
}: FirstRunGateProps): JSX.Element {
  const [path, setPath] = useState<OnboardingPath | null>(null);

  if (host === 'web') {
    return <OnboardingScreen path="ticket" onComplete={onOnboardingComplete} />;
  }
  if (path) {
    return (
      <OnboardingScreen
        path={path}
        onComplete={onOnboardingComplete}
        onBack={() => setPath(null)}
      />
    );
  }

  return (
    <div className={styles.view} data-mounted="true" data-testid="first-run-choice">
      <div className={styles.stageBg} aria-hidden="true" />
      <div className={styles.stageGlow} aria-hidden="true" />
      <div className={styles.card} data-theme="dark">
        <div className={styles.eyebrow}>
          <span className={styles.eyebrowDot} aria-hidden="true" />
          CENTRAID
        </div>
        <h1 className={styles.title}>
          Welcome to <em>Centraid</em>.
        </h1>
        <p className={styles.sub}>Starting something new, or joining what you already run?</p>
        <div className={styles.choiceGrid}>
          <button type="button" className={styles.choiceBtn} onClick={() => setPath('fresh')}>
            <span className={styles.choiceBtnTitle}>Start fresh on this Mac</span>
            <span className={styles.choiceBtnSub}>Your data stays on this computer.</span>
          </button>
          <button type="button" className={styles.choiceBtn} onClick={() => setPath('ticket')}>
            <span className={styles.choiceBtnTitle}>Connect with a ticket</span>
            <span className={styles.choiceBtnSub}>
              Join a gateway you already run — paste or scan a pair ticket.
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
