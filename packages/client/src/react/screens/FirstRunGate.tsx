import { useState } from "react";
import type { JSX } from "react";

import { isWebHost } from "../host-platform.js";
import OnboardingScreen from "./OnboardingScreen.js";
import type {
  OnboardingCompleteInput,
  OnboardingPath,
} from "./OnboardingScreen.js";

// The chooser is step ZERO of onboarding, so it wears onboarding's sheet.
// Borrowing RecoverScreen's module instead is how the product's first screen
// and its second screen end up looking like two different apps.
import styles from "./OnboardingScreen.module.css";

/**
 * First run branches on PLATFORM, not on gateway state (#603).
 *
 * There is no founding ceremony and no "uninitialized" gateway any more: a
 * fresh gateway founds one marked personal vault at construction, so the
 * only question left is which gateway this device should talk to. Shared
 * vaults are created later by an explicit owner action.
 *
 *   - Desktop (Electron) can answer two ways, so it gets a chooser: start a
 *     fresh gateway on this Mac, or join one that already exists with a pair
 *     ticket.
 *   - Web (PWA) can only ever join — there is no gateway to start inside a
 *     browser tab — so it renders the ticket path directly, with no chooser
 *     and no probe.
 *
 * Both paths hand off to the shell after one connection act. Profile details
 * are optional Settings choices, not an onboarding gate.
 */
export interface FirstRunGateProps {
  /** Completion after the gateway connection — boot writes the stamp and
   *  swaps in the app. */
  onOnboardingComplete: (
    input: OnboardingCompleteInput
  ) => Promise<void> | void;
  /** Override the platform decision. Defaults to `isWebHost()`. */
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
