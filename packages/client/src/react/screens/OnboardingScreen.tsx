import { useEffect, useRef, useState } from "react";
import type { CSSProperties, JSX } from "react";

import type { ConnectFlowResult } from "../shell/routes/connectFlow-core.js";
import { connectFreshLocalGateway } from "../shell/routes/connectFlowIO.js";
import ConnectTicketPanel, {
  CONNECT_TICKET_INTRO,
} from "../shell/routes/ConnectTicketPanel.js";
import { isNameSet, loadSelfProfile } from "../shell/routes/profileData.js";
import Button from "../ui/Button.js";
import { ErrorNote } from "./OnboardingErrorNote.js";
import {
  AVATAR_PALETTE,
  OnboardingIdentityStep,
} from "./OnboardingIdentityStep.js";
import { OnboardingImportStep } from "./OnboardingImportStep.js";
import { useKeychainPromptExpected } from "./useKeychainPrompt.js";

import styles from "./OnboardingScreen.module.css";

/**
 * Which gateway this first run is landing on (issue #603). `fresh` is the
 * desktop's own embedded gateway, which auto-founds its vaults — there is
 * nothing to connect, so the connect step is skipped entirely. `ticket`
 * joins an existing gateway and is the ONLY path a browser can take.
 */
export type OnboardingPath = "fresh" | "ticket";

export interface OnboardingCompleteInput {
  displayName: string;
  avatarColor: string;
  /** The gateway ConnectFlow actually connected — `updateProfileMetadata`
   *  should land on THIS profile, not always `'local'` (issue #382 fixes
   *  the prior always-writes-'local' bug: pairing a remote gateway during
   *  onboarding used to leave that profile's name/color blank). */
  gatewayId: string;
  /** The vault this run addressed. On the `fresh` path it is normally the
   *  owner's auto-founded "Personal" vault, which the host renames to their
   *  name — but see `ownerVault`. */
  vaultId: string;
  /** True only when `vaultId` is the auto-founded "Personal" vault, i.e. safe
   *  to rename to the display name (issue #603 C10). */
  ownerVault?: boolean;
  /** The roster owner this device acts as. Present only when onboarding
   *  actually asked for a name, i.e. the owner was still the placeholder —
   *  the host renames it so Household sees a person, not "You". */
  ownerId?: string;
  path: OnboardingPath;
}
export interface OnboardingScreenProps {
  path: OnboardingPath;
  onComplete: (input: OnboardingCompleteInput) => Promise<void> | void;
  /** Rendered as a "Back" affordance on the identity step — the desktop
   *  chooser passes it so its two options are not a one-way door. */
  onBack?: () => void;
}

/**
 * First-run onboarding — connect → (local only) H5 OS service offer →
 * identity, and only when the household doesn't already know this person.
 * Identity now lands on the roster owner (`profileData.ts`), so returning
 * devices no longer re-introduce someone the household already knows.
 */
export default function OnboardingScreen({
  path,
  onComplete,
  onBack,
}: OnboardingScreenProps): JSX.Element {
  // The ticket path opens on the pairing field. The fresh path has no gateway
  // to join, so it gets its OWN step: it must never fall through to `connect`,
  // whose ConnectFlow asks for a pair ticket. That fall-through was the bug —
  // a failed fresh dial unmasked the join-a-gateway UI, so "Start fresh on this
  // Mac" answered with a paste/scan-a-ticket screen.
  const [step, setStep] = useState<
    "identity" | "connect" | "connecting" | "import"
  >(path === "fresh" ? "connecting" : "connect");
  // Bumped by Retry to re-run the fresh dial effect.
  const [dialAttempt, setDialAttempt] = useState(0);
  const [displayName, setDisplayName] = useState("");
  const [selfOwnerId, setSelfOwnerId] = useState<string | null>(null);
  const [avatarColor, setAvatarColor] = useState<string>(
    () =>
      AVATAR_PALETTE[Math.floor(Math.random() * AVATAR_PALETTE.length)] ??
      AVATAR_PALETTE[0]
  );
  // The fresh path starts already busy: it dials its embedded gateway on
  // mount, so the very first paint should read as working, not as idle.
  const [submitting, setSubmitting] = useState(path === "fresh");
  // `error` is the sentence the owner reads; `errorDetail` is the raw exception
  // behind it, rendered collapsed. They are always set together so a later
  // failure can never inherit the previous one's technical detail.
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [pendingResult, setPendingResult] = useState<ConnectFlowResult | null>(
    null
  );
  // Warn before first-write keychain prompts (dev/unsigned builds, #603). The
  // ticket step's own copy comes from ConnectTicketPanel, which probes the
  // same way; this instance covers the steps the panel never renders (the
  // fresh path's `connecting` and the identity step).
  const keychainNote = useKeychainPromptExpected();
  const [wantsImport, setWantsImport] = useState(false);
  const [stagedCount, setStagedCount] = useState(0);
  // Keep fresh-path dialing stable across new `afterConnect` closures.
  const afterConnectRef = useRef<(result: ConnectFlowResult) => void>(
    () => undefined
  );

  const showError = (summary: string, detail?: unknown): void => {
    setError(summary);
    setErrorDetail(
      detail === undefined
        ? null
        : detail instanceof Error
          ? detail.message
          : String(detail)
    );
  };
  const clearError = (): void => {
    setError(null);
    setErrorDetail(null);
  };

  const finish = (result: ConnectFlowResult): void => {
    setSubmitting(true);
    clearError();
    void (async () => {
      try {
        await onComplete({
          avatarColor,
          displayName: displayName.trim(),
          gatewayId: result.gatewayId,
          ...(result.ownerVault === undefined
            ? {}
            : { ownerVault: result.ownerVault }),
          ...(selfOwnerId ? { ownerId: selfOwnerId } : {}),
          vaultId: result.vaultId,
          path,
        });
      } catch (caughtError) {
        setSubmitting(false);
        showError(
          "Couldn't save your name and color. Nothing else was changed — try Continue again.",
          caughtError
        );
      }
    })();
  };

  const finishOrImport = (result: ConnectFlowResult): void => {
    if (!wantsImport) {
      finish(result);
      return;
    }
    setPendingResult(result);
    setSubmitting(false);
    setStep("import");
  };

  /**
   * Last gate before the shell: ask the roster who this device acts as. An
   * owner that already has a name needs no introduction, so onboarding ends
   * here; anyone else gets the identity step.
   *
   * An unreadable roster also asks: one extra screen is safe, while skipping
   * would finish with an empty identity and try to rename the Personal vault
   * to an empty string.
   */
  const identityOrFinish = (result: ConnectFlowResult): void => {
    setSubmitting(true);
    void loadSelfProfile()
      .catch(() => undefined)
      .then((profile) => {
        setSubmitting(false);
        if (profile && isNameSet(profile)) {
          finish(result);
          return;
        }
        if (profile) {
          setSelfOwnerId(profile.ownerId);
          setAvatarColor(profile.avatarColor);
        }
        setPendingResult(result);
        setStep("identity");
      });
  };

  const continueFromIdentity = (): void => {
    if (!displayName.trim() || submitting || !pendingResult) return;
    clearError();
    finishOrImport(pendingResult);
  };

  /**
   * After connect, go straight to identity.
   *
   * The H5 OS service install used to be a BLOCKING onboarding step here, which
   * asked a first-time user to decide about background daemons before they had
   * seen the product. It is now a non-blocking offer on the Gateway screen
   * (`GatewayServiceTip`). Onboarding deliberately leaves `offerGatewayService`
   * UNSET: `shouldOfferServiceInstall()` treats "unset" as still-offerable, so
   * moving the question out of onboarding is what keeps it askable later.
   */
  const afterConnect = (result: ConnectFlowResult): void => {
    identityOrFinish(result);
  };

  // Populate the continuation ref before the connect effect can resolve.
  useEffect(() => {
    afterConnectRef.current = afterConnect;
  });

  // A fresh client connects to its auto-founded gateway on mount. On failure it
  // STAYS on the `connecting` step and shows the reason plus a Retry — the local
  // gateway failing to start is a recoverable local fault, not a reason to ask
  // the user for someone else's pair ticket.
  useEffect(() => {
    if (path !== "fresh") return;
    let cancelled = false;
    // No synchronous setState here: `submitting` already initialises true for
    // the fresh path, and Retry clears the previous error before bumping
    // `dialAttempt`, so the effect body stays free of cascading renders.
    void connectFreshLocalGateway()
      .then((result) => {
        if (cancelled) return;
        setSubmitting(false);
        afterConnectRef.current(result);
      })
      .catch((caughtError: unknown) => {
        if (cancelled) return;
        setSubmitting(false);
        // One honest sentence, not a taxonomy: from the message text alone we
        // cannot reliably tell a locked database from a refused socket from a
        // half-written data dir, and guessing wrong is worse than not guessing.
        // The exception itself stays one disclosure away.
        showError(
          "Centraid couldn't start on this Mac. This is usually temporary — try again, and if it keeps happening, quit Centraid completely and reopen it.",
          caughtError
        );
      });
    return () => {
      cancelled = true;
    };
    // `path` and the retry counter are the only real dependencies: the
    // continuation is read through a ref so a re-render can't redial a gateway
    // this client already joined.
  }, [path, dialAttempt]);

  // Where this run is in the threshold (moment M15 carries `step-indicator`).
  // The total is two until the owner says they have data to bring, because
  // promising a third step to everyone and then not showing it is the kind of
  // small lie a first run cannot afford.
  const stepTotal = wantsImport ? 3 : 2;
  const stepIndex = step === "identity" ? 2 : step === "import" ? 3 : 1;

  return (
    <div
      className={styles.view}
      data-testid="onboarding-view"
      data-mounted="true"
      style={{ "--onb-accent": avatarColor } as CSSProperties}
    >
      <div className={styles.card} data-step={step}>
        <div className={styles.eyebrow}>
          <span className={styles.eyebrowDot} aria-hidden="true" />
          Centraid
          <span className={styles.step}>
            {stepIndex} of {stepTotal}
          </span>
        </div>
        {step === "identity" ? (
          <>
            <h1 className={styles.title}>
              Make yourself <em>at home</em>.
            </h1>
            <p className={styles.sub}>
              You&rsquo;re in. Tell your household who you are — a name and a
              color, changeable any time from Settings.
            </p>
          </>
        ) : step === "connect" ? (
          <>
            {/* Vault-first: the ticket joins a VAULT, and the gateway hosting
                it never needs a name here. The sentence is shared with the
                switcher's "Add vault" modal so both surfaces explain a ticket
                identically. */}
            <h1 className={styles.title}>
              Connect your <em>vault</em>.
            </h1>
            <p className={styles.sub}>{CONNECT_TICKET_INTRO}</p>
          </>
        ) : step === "connecting" ? (
          <>
            {/* One word for one moment (UX-8). This step used to open as
                "Setting up your vault." and fail as "Couldn't start your
                gateway." — two terms a first-timer has met neither of. The
                product's own name is the thing they DO know, and "vault" is
                the owner-facing word (docs/glossary.md), so the
                title, the sub, and the working line all say the same thing. */}
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
                ? "Your data is safe — nothing was created. Everything here runs on this Mac, so retrying is worth trying before anything else."
                : "Starting Centraid on this Mac and preparing your vaults. This takes a moment the first time."}
            </p>
          </>
        ) : (
          <>
            <h1 className={styles.title}>
              Bring your data <em>home</em>.
            </h1>
            <p className={styles.sub}>
              Stage an export from another calendar, contacts, notes, mail, or
              finance app. You stay in control of the final publish.
            </p>
          </>
        )}
        {step === "identity" ? (
          <OnboardingIdentityStep
            displayName={displayName}
            onDisplayName={setDisplayName}
            avatarColor={avatarColor}
            onAvatarColor={setAvatarColor}
            wantsImport={wantsImport}
            onWantsImport={setWantsImport}
            submitting={submitting}
            showKeychainNote={keychainNote && path === "fresh"}
            error={error}
            errorDetail={errorDetail}
            onContinue={continueFromIdentity}
            onBack={onBack}
          />
        ) : step === "connect" ? (
          // No `data-theme="dark"` any more: the screen is themed like every
          // other surface now, so the panel inherits the owner's own ramp.
          <div className={styles.connectPanel}>
            <ConnectTicketPanel
              context="onboarding"
              {...(onBack ? { onCancel: onBack } : {})}
              onDone={afterConnect}
            />
            {error ? <ErrorNote summary={error} detail={errorDetail} /> : null}
          </div>
        ) : step === "connecting" ? (
          <div className={styles.form} data-testid="onboarding-connecting">
            {error ? (
              <>
                <ErrorNote summary={error} detail={errorDetail} />
                {/* Retrying a local dial writes nothing, so `commit={false}`:
                    the filled ink is about being the one primary here, not
                    about committing, and an offline shell must not refuse the
                    button whose whole job is to get back online. */}
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
                      setDialAttempt((n) => n + 1);
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
        ) : (
          <OnboardingImportStep
            submitting={submitting}
            onSubmitting={setSubmitting}
            stagedCount={stagedCount}
            onStaged={(total) => setStagedCount((count) => count + total)}
            error={error}
            errorDetail={errorDetail}
            onError={showError}
            onClearError={clearError}
            canFinish={pendingResult !== null}
            onFinish={() => pendingResult && finish(pendingResult)}
            onBack={() => {
              clearError();
              setStep("identity");
            }}
          />
        )}
      </div>
    </div>
  );
}
