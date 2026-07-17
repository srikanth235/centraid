import { useState, type JSX } from 'react';
import OnboardingScreen, { type OnboardingCompleteInput } from './OnboardingScreen.js';
import RecoverScreen, { type RecoverScreenBridge } from './RecoverScreen.js';
import styles from './RecoverScreen.module.css';

/**
 * The first-run gate (issue #439 §UI flow, step 1) — ONE binary decision before
 * anything else: "Start fresh" or "Recover my vault", the same discipline #436
 * applied to storage. It is a thin parent switcher (chosen over threading a
 * third mode through OnboardingScreen): the fresh path is the existing
 * `OnboardingScreen` untouched (identity → connect), the recover path is
 * `RecoverScreen`, and each completes into the same "onboarding done → boot the
 * app" state via its own callback. Rendered by boot.tsx in place of the bare
 * `OnboardingScreen` when `onboardingCompletedAt` is unset.
 */
export interface FirstRunGateProps {
  /** Fresh path completion (identity + connected gateway) — boot writes the
   *  profile + onboarding stamp and swaps in the app. */
  onOnboardingComplete: (input: OnboardingCompleteInput) => Promise<void> | void;
  /** Recover path completion — the vault is already mounted; boot re-reads its
   *  auth against the recovered vault, stamps onboarding, and swaps in the app. */
  onRecoveryComplete: () => Promise<void> | void;
  /** The recovery client bridge (the gateway-client-recover functions). */
  recover: RecoverScreenBridge;
}

export default function FirstRunGate({
  onOnboardingComplete,
  onRecoveryComplete,
  recover,
}: FirstRunGateProps): JSX.Element {
  const [mode, setMode] = useState<'choice' | 'fresh' | 'recover'>('choice');

  if (mode === 'fresh') {
    return <OnboardingScreen onComplete={onOnboardingComplete} />;
  }
  if (mode === 'recover') {
    return (
      <RecoverScreen
        {...recover}
        onRecovered={onRecoveryComplete}
        onBack={() => setMode('choice')}
      />
    );
  }

  return (
    <div className={styles.view} data-mounted="true">
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
        <p className={styles.sub}>Starting fresh, or bringing a vault back from a backup?</p>
        <div className={styles.choiceGrid}>
          <button type="button" className={styles.choiceBtn} onClick={() => setMode('fresh')}>
            <span className={styles.choiceBtnTitle}>Start fresh</span>
            <span className={styles.choiceBtnSub}>Set up a brand-new vault on this computer.</span>
          </button>
          <button type="button" className={styles.choiceBtn} onClick={() => setMode('recover')}>
            <span className={styles.choiceBtnTitle}>Recover my vault</span>
            <span className={styles.choiceBtnSub}>
              Bring everything back from your recovery kit.
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
