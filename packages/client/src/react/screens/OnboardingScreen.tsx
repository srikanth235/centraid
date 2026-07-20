import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import ConnectFlow from '../shell/routes/ConnectFlow.js';
import type { ConnectFlowResult } from '../shell/routes/connectFlow-core.js';
import styles from './OnboardingScreen.module.css';

export interface OnboardingCompleteInput {
  displayName: string;
  avatarColor: string;
  /** The gateway ConnectFlow actually connected — `updateProfileMetadata`
   *  should land on THIS profile, not always `'local'` (issue #382 fixes
   *  the prior always-writes-'local' bug: pairing a remote gateway during
   *  onboarding used to leave that profile's name/color blank). */
  gatewayId: string;
}
export interface OnboardingScreenProps {
  onComplete: (input: OnboardingCompleteInput) => Promise<void> | void;
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
 * First-run onboarding (issue #325, redesigned around (gateway, vault) pairs
 * for issue #382) — two steps on one root: (1) identity — a name and a
 * color, (2) "Where does your data live?" — the shared ConnectFlow wizard's
 * method cards, embedded. Styles are co-located in
 * `OnboardingScreen.module.css` (scoped CSS Modules).
 */
export default function OnboardingScreen({ onComplete }: OnboardingScreenProps): JSX.Element {
  const [step, setStep] = useState<'identity' | 'connect'>('identity');
  const [displayName, setDisplayName] = useState('');
  // Random initial color so two fresh installs on the same machine don't both
  // start on the same swatch.
  const [avatarColor, setAvatarColor] = useState<string>(
    () => AVATAR_PALETTE[Math.floor(Math.random() * AVATAR_PALETTE.length)] ?? AVATAR_PALETTE[0],
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step !== 'identity') return;
    // One frame so the CSS entry animation isn't fighting the focus shift.
    const id = requestAnimationFrame(() => nameRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [step]);

  const ready = displayName.trim().length > 0 && !submitting;

  const goToConnect = (): void => {
    if (!displayName.trim() || submitting) return;
    setError(null);
    setStep('connect');
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
        });
        // Host replaces the root with home — nothing else to do.
      } catch (err) {
        setSubmitting(false);
        setError(`Couldn't save your profile: ${err instanceof Error ? err.message : String(err)}`);
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
        ) : (
          <>
            <h1 className={styles.title}>
              Where does your <em>data live</em>?
            </h1>
            <p className={styles.sub}>
              Everything you do happens inside one space. Keep it on this Mac, or connect to a
              gateway running elsewhere.
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
              goToConnect();
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
                  goToConnect();
                }
              }}
            />
            <span className={styles.fieldLabel} id="cd-onb-color-label">
              Pick a color
            </span>
            <div className={styles.swatches} role="radiogroup" aria-labelledby="cd-onb-color-label">
              {AVATAR_PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={styles.swatch}
                  role="radio"
                  aria-label={`Color ${c}`}
                  aria-checked={c === avatarColor}
                  data-color={c}
                  data-selected={c === avatarColor ? 'true' : 'false'}
                  style={{ background: c }}
                  onClick={(e) => {
                    e.preventDefault();
                    setAvatarColor(c);
                  }}
                />
              ))}
            </div>
            <button
              type="button"
              className={styles.cta}
              disabled={!ready}
              data-state={submitting ? 'submitting' : ready ? 'ready' : 'idle'}
              onClick={goToConnect}
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
          </form>
        ) : (
          <div className={styles.connectPanel} data-theme="dark">
            <ConnectFlow
              context="onboarding"
              onCancel={() => setStep('identity')}
              onDone={finish}
            />
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
