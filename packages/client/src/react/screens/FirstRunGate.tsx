import { useState, type JSX } from 'react';
import OnboardingScreen, { type OnboardingCompleteInput } from './OnboardingScreen.js';
import FoundingScreen, { type FoundingScreenBridge } from './FoundingScreen.js';
import styles from './RecoverScreen.module.css';

/**
 * First run branches on gateway state, not installation state. A founded
 * gateway only accepts device onboarding; Create / Restore appears solely on
 * a verified zero-vault gateway and both founding peers use the same screen.
 */
export interface FirstRunGateProps {
  /** Fresh path completion (identity + connected gateway) — boot writes the
   *  profile + onboarding stamp and swaps in the app. */
  onOnboardingComplete: (input: OnboardingCompleteInput) => Promise<void> | void;
  onFoundingComplete: () => Promise<void> | void;
  founding: FoundingScreenBridge;
  gatewayStatus: 'uninitialized' | 'ready' | 'unreachable';
}

export default function FirstRunGate({
  onOnboardingComplete,
  onFoundingComplete,
  founding,
  gatewayStatus,
}: FirstRunGateProps): JSX.Element {
  const [mode, setMode] = useState<'choice' | 'create' | 'restore'>('choice');

  if (gatewayStatus !== 'uninitialized') {
    return <OnboardingScreen onComplete={onOnboardingComplete} />;
  }
  if (mode === 'create' || mode === 'restore') {
    return (
      <FoundingScreen
        {...founding}
        mode={mode}
        onComplete={onFoundingComplete}
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
          <button type="button" className={styles.choiceBtn} onClick={() => setMode('create')}>
            <span className={styles.choiceBtnTitle}>Create vault</span>
            <span className={styles.choiceBtnSub}>Found a brand-new vault on this gateway.</span>
          </button>
          <button type="button" className={styles.choiceBtn} onClick={() => setMode('restore')}>
            <span className={styles.choiceBtnTitle}>Restore vault</span>
            <span className={styles.choiceBtnSub}>
              Bring backed-up vaults back from your recovery kit.
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
