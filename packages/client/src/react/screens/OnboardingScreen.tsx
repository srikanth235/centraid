import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import ConnectFlow from '../shell/routes/ConnectFlow.js';
import { connectFreshLocalGateway } from '../shell/routes/connectFlowIO.js';
import type { ConnectFlowResult } from '../shell/routes/connectFlow-core.js';
import a11y from '../styles/a11y.module.css';
import styles from './OnboardingScreen.module.css';

/**
 * Which gateway this first run is landing on (issue #603). `fresh` is the
 * desktop's own embedded gateway, which auto-founds its vaults — there is
 * nothing to connect, so the connect step is skipped entirely. `ticket`
 * joins an existing gateway and is the ONLY path a browser can take.
 */
export type OnboardingPath = 'fresh' | 'ticket';

export interface OnboardingCompleteInput {
  displayName: string;
  avatarColor: string;
  /** The gateway ConnectFlow actually connected — `updateProfileMetadata`
   *  should land on THIS profile, not always `'local'` (issue #382 fixes
   *  the prior always-writes-'local' bug: pairing a remote gateway during
   *  onboarding used to leave that profile's name/color blank). */
  gatewayId: string;
  /** The vault this run addressed. On the `fresh` path it is the owner's
   *  auto-founded "Personal" vault, which the host renames to their name. */
  vaultId: string;
  path: OnboardingPath;
}
export interface OnboardingScreenProps {
  path: OnboardingPath;
  onComplete: (input: OnboardingCompleteInput) => Promise<void> | void;
  /** Rendered as a "Back" affordance on the identity step — the desktop
   *  chooser passes it so its two options are not a one-way door. */
  onBack?: () => void;
}

// Mirror of gateway-store.ts#AVATAR_PALETTE (values round-trip through
// updateProfileMetadata, which validates #RRGGBB).
const AVATAR_PALETTE = [
  '#5B8DEF',
  '#7C5CFF',
  '#E36AD2',
  '#E5734A',
  '#E0B53D',
  '#4FB077',
  '#3FB5C7',
  '#B07A4A',
] as const;

function initials(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return '·';
  const parts = trimmed.split(/\s+/).filter((w) => w.length > 0);
  if (parts.length === 1) {
    const w = parts[0] ?? '';
    return (w.charAt(0) + (w.charAt(1) || '')).toUpperCase();
  }
  return ((parts[0]?.charAt(0) ?? '') + (parts[1]?.charAt(0) ?? '')).toUpperCase();
}

/**
 * First-run onboarding — identity → (ticket path only) connect → (local only)
 * H5 OS service offer → complete. Every path collects identity (issue #603
 * D2). Styles in `OnboardingScreen.module.css`.
 */
export default function OnboardingScreen({
  path,
  onComplete,
  onBack,
}: OnboardingScreenProps): JSX.Element {
  const [step, setStep] = useState<'identity' | 'connect' | 'service'>('identity');
  const [displayName, setDisplayName] = useState('');
  const [avatarColor, setAvatarColor] = useState<string>(
    () => AVATAR_PALETTE[Math.floor(Math.random() * AVATAR_PALETTE.length)] ?? AVATAR_PALETTE[0],
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingResult, setPendingResult] = useState<ConnectFlowResult | null>(null);
  const [keychainNote, setKeychainNote] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  // Where the OS keychain will prompt on the first secret write (dev/unsigned
  // builds, some Linux keyrings — issue #603), say so before triggering it.
  // The bridge method is desktop-only; a missing method means no prompt.
  useEffect(() => {
    const probe = window.CentraidApi.keychainPromptExpected;
    if (!probe) return;
    let cancelled = false;
    probe().then(
      (expected) => {
        if (!cancelled) setKeychainNote(expected);
      },
      (err: unknown) => {
        // A broken probe must not block onboarding, but losing the note means
        // the OS dialog arrives unannounced — leave a trace for debugging.
        console.error('keychainPromptExpected probe failed', err);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (step !== 'identity') return;
    const id = requestAnimationFrame(() => nameRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [step]);

  const ready = displayName.trim().length > 0 && !submitting;

  /**
   * Identity is done. The `ticket` path still has a gateway to join; the
   * `fresh` path only has to point this client at the auto-founded local
   * gateway, which happens without a single question.
   */
  const continueFromIdentity = (): void => {
    if (!displayName.trim() || submitting) return;
    setError(null);
    if (path === 'ticket') {
      setStep('connect');
      return;
    }
    setSubmitting(true);
    void (async () => {
      try {
        const result = await connectFreshLocalGateway();
        setSubmitting(false);
        afterConnect(result);
      } catch (err) {
        setSubmitting(false);
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  };

  const finish = (result: ConnectFlowResult): void => {
    setSubmitting(true);
    setError(null);
    void (async () => {
      try {
        await onComplete({
          avatarColor,
          displayName: displayName.trim(),
          gatewayId: result.gatewayId,
          vaultId: result.vaultId,
          path,
        });
      } catch (err) {
        setSubmitting(false);
        setError(`Couldn't save your profile: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  };

  /**
   * After connect: for the local gateway, offer H5 OS service install
   * (default off). Remote gateways skip — service install is about the
   * machine's own detached child.
   */
  const afterConnect = (result: ConnectFlowResult): void => {
    const isLocal = result.gatewayId === 'local' || result.gatewayId.startsWith('local');
    const canInstall = typeof window.CentraidApi?.installGatewayService === 'function';
    if (isLocal && canInstall) {
      setPendingResult(result);
      setStep('service');
      return;
    }
    finish(result);
  };

  const declineService = (): void => {
    if (!pendingResult) return;
    void window.CentraidApi.saveSettings?.({ offerGatewayService: false });
    finish(pendingResult);
  };

  const acceptService = (): void => {
    if (!pendingResult || submitting) return;
    setSubmitting(true);
    setError(null);
    void (async () => {
      try {
        const install = window.CentraidApi.installGatewayService;
        if (install) {
          const res = await install();
          if (!res.ok) {
            setSubmitting(false);
            setError(res.error || 'Service install failed');
            return;
          }
        }
        await window.CentraidApi.saveSettings?.({ offerGatewayService: true });
        finish(pendingResult);
      } catch (err) {
        setSubmitting(false);
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  };

  return (
    <div
      className={styles.view}
      data-testid="onboarding-view"
      data-mounted="true"
      style={{ '--onb-accent': avatarColor } as CSSProperties}
    >
      <div className={styles.stageBg} aria-hidden="true" />
      <div className={styles.stageGlow} aria-hidden="true" />
      <div className={styles.card} data-step={step}>
        <div className={styles.eyebrow}>
          <span className={styles.eyebrowDot} aria-hidden="true" />
          CENTRAID
        </div>
        {step === 'identity' ? (
          <>
            <h1 className={styles.title}>
              Make yourself <em>at home</em>.
            </h1>
            <p className={styles.sub}>
              A name and a color. We use them for your profile — you can change either at any time.
            </p>
          </>
        ) : step === 'connect' ? (
          <>
            <h1 className={styles.title}>
              Connect your <em>gateway</em>.
            </h1>
            <p className={styles.sub}>
              Paste or scan the pair ticket from the gateway you already run. It decides which space
              you land in.
            </p>
          </>
        ) : (
          <>
            <h1 className={styles.title}>
              Keep your vault <em>reachable</em>?
            </h1>
            <p className={styles.sub}>
              Optionally install a small background service so your gateway stays up when Centraid
              is closed — phones and other devices can still reach your vault. Default is off; we
              never install this without asking.
            </p>
          </>
        )}
        {step === 'identity' ? (
          <div className={styles.avatarWrap}>
            <span className={styles.avatarRing} aria-hidden="true" />
            <span className={styles.avatar} style={{ background: avatarColor }} aria-hidden="true">
              <span className={styles.initials}>{initials(displayName)}</span>
            </span>
          </div>
        ) : null}
        {step === 'identity' ? (
          <form
            className={styles.form}
            onSubmit={(e) => {
              e.preventDefault();
              continueFromIdentity();
            }}
          >
            <label className={styles.fieldLabel} htmlFor="cd-onb-name">
              Your name
            </label>
            <input
              ref={nameRef}
              id="cd-onb-name"
              className={styles.input}
              type="text"
              placeholder="What should we call you?"
              autoCapitalize="words"
              autoComplete="name"
              spellCheck={false}
              aria-label="Your name"
              maxLength={60}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  continueFromIdentity();
                }
              }}
            />
            <span className={styles.fieldLabel} id="cd-onb-color-label">
              Pick a color
            </span>
            <div className={styles.swatches} role="radiogroup" aria-labelledby="cd-onb-color-label">
              {AVATAR_PALETTE.map((c) => (
                <label
                  key={c}
                  className={styles.swatch}
                  data-color={c}
                  data-selected={c === avatarColor ? 'true' : 'false'}
                  style={{ background: c }}
                >
                  <input
                    type="radio"
                    className={a11y.srControl}
                    name="onboarding-avatar-color"
                    aria-label={`Color ${c}`}
                    checked={c === avatarColor}
                    onChange={() => setAvatarColor(c)}
                  />
                </label>
              ))}
            </div>
            <button
              type="button"
              className={styles.cta}
              disabled={!ready}
              data-state={submitting ? 'submitting' : ready ? 'ready' : 'idle'}
              onClick={continueFromIdentity}
            >
              <span>Continue</span>
              <span className={styles.ctaArrow}>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </span>
            </button>
            {keychainNote && path === 'fresh' ? (
              <p className={styles.keychainNote}>
                Continuing stores this device&rsquo;s keys in your system keychain — your OS may ask
                once to allow it.
              </p>
            ) : null}
            {error ? (
              <div className={styles.error} role="alert">
                {error}
              </div>
            ) : null}
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
          </form>
        ) : step === 'connect' ? (
          <div className={styles.connectPanel} data-theme="dark">
            <ConnectFlow
              context="onboarding"
              methods={['gateway']}
              initialMethod="gateway"
              onCancel={() => setStep('identity')}
              onDone={afterConnect}
            />
            {keychainNote ? (
              <p className={styles.keychainNote}>
                Connecting stores this device&rsquo;s keys in your system keychain — your OS may ask
                once to allow it.
              </p>
            ) : null}
            {error ? (
              <div className={styles.error} role="alert">
                {error}
              </div>
            ) : null}
          </div>
        ) : (
          <div className={styles.form}>
            <button
              type="button"
              className={styles.cta}
              disabled={submitting}
              data-testid="onboarding-service-accept"
              onClick={acceptService}
            >
              <span>{submitting ? 'Installing…' : 'Keep vault reachable'}</span>
            </button>
            <button
              type="button"
              className={styles.cta}
              style={{ marginTop: 12, opacity: 0.85 }}
              disabled={submitting}
              data-testid="onboarding-service-decline"
              onClick={declineService}
            >
              <span>Not now</span>
            </button>
            {error ? (
              <div className={styles.error} role="alert">
                {error}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
