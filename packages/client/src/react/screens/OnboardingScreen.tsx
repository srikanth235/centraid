import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import type { ConnectFlowResult } from "../shell/routes/connectFlow-core.js";
import { connectFreshLocalGateway } from "../shell/routes/connectFlowIO.js";
import ConnectTicketPanel, {
  CONNECT_TICKET_INTRO,
} from "../shell/routes/ConnectTicketPanel.js";
import Button from "../ui/Button.js";
import { ErrorNote } from "./OnboardingErrorNote.js";
import { useKeychainPromptExpected } from "./useKeychainPrompt.js";

import styles from "./OnboardingScreen.module.css";

/** Which gateway this first run is landing on. */
export type OnboardingPath = "fresh" | "ticket";

/** The only onboarding decision left after the connection succeeds. */
export interface OnboardingCompleteInput {
  path: OnboardingPath;
}

export interface OnboardingScreenProps {
  path: OnboardingPath;
  onComplete: (input: OnboardingCompleteInput) => Promise<void> | void;
  /** The desktop chooser passes this so its two options are not a one-way door. */
  onBack?: () => void;
}

/**
 * First-run onboarding is deliberately one act: connect, then enter Home.
 * Name and color are profile preferences, so Settings → You owns them and
 * a first-time user never has to invent identity data before seeing the app.
 */
export default function OnboardingScreen({
  path,
  onComplete,
  onBack,
}: OnboardingScreenProps): JSX.Element {
  const step: "connect" | "connecting" =
    path === "fresh" ? "connecting" : "connect";
  const [dialAttempt, setDialAttempt] = useState(0);
  // The fresh path starts already busy: it dials its embedded gateway on
  // mount, so the first paint reads as working rather than idle.
  const [submitting, setSubmitting] = useState(path === "fresh");
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const keychainNote = useKeychainPromptExpected();
  const afterConnectRef = useRef<(result: ConnectFlowResult) => void>(
    () => undefined
  );

  const afterConnect = useCallback(
    (_result: ConnectFlowResult): void => {
      setSubmitting(true);
      setError(null);
      setErrorDetail(null);
      void (async () => {
        try {
          await onComplete({ path });
        } catch (caughtError) {
          setSubmitting(false);
          setError("Centraid setup didn’t finish.");
          setErrorDetail(
            caughtError instanceof Error
              ? caughtError.message
              : String(caughtError)
          );
        }
      })();
    },
    [onComplete, path]
  );

  // Populate the continuation ref before the fresh-connect effect can resolve.
  useEffect(() => {
    afterConnectRef.current = afterConnect;
  }, [afterConnect]);

  // A fresh client connects to its auto-founded gateway on mount. On failure it
  // stays here with one recovery action; it never falls through to the ticket
  // UI, which would ask a first-time desktop user for someone else's gateway.
  useEffect(() => {
    if (path !== "fresh") return;
    let cancelled = false;
    void connectFreshLocalGateway()
      .then((result) => {
        if (cancelled) return;
        setSubmitting(false);
        afterConnectRef.current(result);
      })
      .catch((caughtError: unknown) => {
        if (cancelled) return;
        setSubmitting(false);
        setError("Centraid couldn’t start on this Mac — try again.");
        setErrorDetail(
          caughtError instanceof Error
            ? caughtError.message
            : String(caughtError)
        );
      });
    return () => {
      cancelled = true;
    };
  }, [path, dialAttempt]);

  return (
    <div
      className={styles.view}
      data-testid="onboarding-view"
      data-mounted="true"
    >
      <div className={styles.card} data-step={step}>
        <div className={styles.eyebrow}>
          <span className={styles.eyebrowDot} aria-hidden="true" />
          Centraid
          <span className={styles.step}>1 of 1</span>
        </div>
        {step === "connect" ? (
          <>
            <h1 className={styles.title}>
              Connect your <em>vault</em>.
            </h1>
            <p className={styles.sub}>{CONNECT_TICKET_INTRO}</p>
          </>
        ) : (
          <>
            <h1 className={styles.title}>
              {error ? (
                <>
                  Couldn&rsquo;t set up <em>Centraid</em>.
                </>
              ) : (
                <>
                  Setting up <em>Centraid</em>.
                </>
              )}
            </h1>
            <p className={styles.sub}>
              {error
                ? "Nothing was created."
                : "Starting Centraid and preparing your vaults — a moment the first time."}
            </p>
          </>
        )}
        {step === "connect" ? (
          <div className={styles.connectPanel}>
            <ConnectTicketPanel
              context="onboarding"
              {...(onBack ? { onCancel: onBack } : {})}
              onDone={afterConnect}
            />
            {error ? <ErrorNote summary={error} detail={errorDetail} /> : null}
          </div>
        ) : (
          <div className={styles.form} data-testid="onboarding-connecting">
            {error ? (
              <>
                <ErrorNote summary={error} detail={errorDetail} />
                <div data-testid="onboarding-connect-retry">
                  <Button
                    className={styles.cta}
                    label="Try again"
                    variant="primary"
                    commit={false}
                    disabled={submitting}
                    onClick={() => {
                      setSubmitting(true);
                      setError(null);
                      setErrorDetail(null);
                      setDialAttempt((attempt) => attempt + 1);
                    }}
                  />
                </div>
                {onBack ? (
                  <button
                    type="button"
                    className={styles.backBtn}
                    disabled={submitting}
                    onClick={onBack}
                  >
                    Back
                  </button>
                ) : null}
              </>
            ) : (
              <output className={styles.working}>
                <span className={styles.workingDot} aria-hidden="true" />
                <span>Setting up Centraid…</span>
              </output>
            )}
            {keychainNote ? (
              <p className={styles.keychainNote}>
                Setting up stores this device&rsquo;s keys in your system
                keychain — your OS may ask once to allow it.
              </p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
