import { useState } from "react";
import type { JSX } from "react";

import { isWebHost } from "../host-platform.js";
import OnboardingScreen from "./OnboardingScreen.js";
import type {
  OnboardingCompleteInput,
  OnboardingPath,
} from "./OnboardingScreen.js";

// Chooser = step ZERO of onboarding; it wears onboarding's sheet, not
// RecoverScreen's.
import styles from "./OnboardingScreen.module.css";

/**
 * Branches on PLATFORM, not gateway state (#603): desktop gets a chooser
 * (fresh vs join with a ticket); web can only join and renders the ticket
 * path directly. Profile details are optional Settings choices, not a gate.
 */
export interface FirstRunGateProps {
  onOnboardingComplete: (
    input: OnboardingCompleteInput
  ) => Promise<void> | void;
  host?: "desktop" | "web";
}

export default function FirstRunGate({
  onOnboardingComplete,
  host = isWebHost() ? "web" : "desktop",
}: FirstRunGateProps): JSX.Element {
  const [path, setPath] = useState<OnboardingPath | null>(null);

  if (host === "web") {
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
    <div
      className={styles.view}
      data-mounted="true"
      data-testid="first-run-choice"
    >
      <div className={styles.card}>
        <div className={styles.eyebrow}>
          <span className={styles.eyebrowDot} aria-hidden="true" />
          Centraid
        </div>
        <h1 className={styles.title}>
          Welcome to <em>Centraid</em>.
        </h1>
        <p className={styles.sub}>
          Starting something new, or joining what you already run?
        </p>
        <div className={styles.choiceGrid}>
          <button
            type="button"
            className={styles.choiceBtn}
            onClick={() => setPath("fresh")}
          >
            <span className={styles.choiceBtnTitle}>
              Start fresh on this Mac
            </span>
            <span className={styles.choiceBtnSub}>
              Your data stays on this computer.
            </span>
          </button>
          <button
            type="button"
            className={styles.choiceBtn}
            onClick={() => setPath("ticket")}
          >
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
