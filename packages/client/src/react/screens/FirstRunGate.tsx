import { useState, type JSX } from 'react';

import FoundingScreen, { type FoundingScreenBridge } from './FoundingScreen.js';
import OnboardingScreen, { type OnboardingCompleteInput } from './OnboardingScreen.js';

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
  /**
   * The gateway created its vault but never verified the kit (issue #568
   * item G). Without this the choice screen is a dead end after a restart:
   * Create 409s `already_initialized`, Restore 409s, and erase 409s
   * `recovery_kit_not_verified` — only `vaults:initialize/verify` moves.
   */
  foundingPending?: boolean;
}

export default function FirstRunGate({
  onOnboardingComplete,
  onFoundingComplete,
  founding,
  gatewayStatus,
  foundingPending = false,
}: FirstRunGateProps): JSX.Element {
  const [mode, setMode] = useState<'choice' | 'create' | 'restore' | 'verify'>(
    foundingPending ? 'verify' : 'choice',
  );

  if (gatewayStatus !== 'uninitialized') {
    return <OnboardingScreen onComplete={onOnboardingComplete} />;
  }
  if (mode === 'create' || mode === 'restore' || mode === 'verify') {
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
          {/* Always offered, not only when the gateway reports the pending
              ceremony: an older gateway omits `foundingPending`, and the user
              who closed the app mid-ceremony still needs a way back in. */}
          <button type="button" className={styles.choiceBtn} onClick={() => setMode('verify')}>
            <span className={styles.choiceBtnTitle}>I already have my kit</span>
            <span className={styles.choiceBtnSub}>
              Finish an interrupted setup by verifying the kit this gateway downloaded.
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
