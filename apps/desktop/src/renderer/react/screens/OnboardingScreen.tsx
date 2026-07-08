import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import type { OnboardingBridgeProps } from '../bridge.js';

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
 * First-run onboarding — a name + a color, ported to React (issue #325,
 * Phase 3). On submit it calls the vanilla-supplied `onComplete`; the host then
 * replaces the root with home. Emits the same `cd-onb-*` classes.
 */
export default function OnboardingScreen({ onComplete }: OnboardingBridgeProps): JSX.Element {
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
    // One frame so the CSS entry animation isn't fighting the focus shift.
    const id = requestAnimationFrame(() => nameRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  const ready = displayName.trim().length > 0 && !submitting;

  const submit = (): void => {
    const name = displayName.trim();
    if (!name || submitting) return;
    setSubmitting(true);
    setError(null);
    void (async () => {
      try {
        await onComplete({ avatarColor, displayName: name });
        // Host replaces the root with home — nothing else to do.
      } catch (err) {
        setSubmitting(false);
        setError(`Couldn't save your profile: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  };

  return (
    <div
      className="cd-onb-view"
      data-mounted="true"
      style={{ '--onb-accent': avatarColor } as CSSProperties}
    >
      <div className="cd-onb-stage-bg" aria-hidden="true" />
      <div className="cd-onb-stage-glow" aria-hidden="true" />
      <div className="cd-onb-card">
        <div className="cd-onb-eyebrow">
          <span className="cd-onb-eyebrow-dot" aria-hidden="true" />
          CENTRAID
        </div>
        <h1 className="cd-onb-title">
          Make yourself <em>at home</em>.
        </h1>
        <p className="cd-onb-sub">
          A name and a color. We use them for your local workspace — you can change either at any
          time.
        </p>
        <div className="cd-onb-avatar-wrap">
          <span className="cd-onb-avatar-ring" aria-hidden="true" />
          <span className="cd-onb-avatar" style={{ background: avatarColor }} aria-hidden="true">
            <span className="cd-onb-initials">{initials(displayName)}</span>
          </span>
        </div>
        <form
          className="cd-onb-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className="cd-onb-field-label" htmlFor="cd-onb-name">
            Your name
          </label>
          <input
            ref={nameRef}
            id="cd-onb-name"
            className="cd-onb-input"
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
                submit();
              }
            }}
          />
          <span className="cd-onb-field-label" id="cd-onb-color-label">
            Pick a color
          </span>
          <div className="cd-onb-swatches" role="radiogroup" aria-labelledby="cd-onb-color-label">
            {AVATAR_PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                className="cd-onb-swatch"
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
            className="cd-onb-cta"
            disabled={!ready}
            data-state={submitting ? 'submitting' : ready ? 'ready' : 'idle'}
            onClick={submit}
          >
            <span className="cd-onb-cta-label">Enter Centraid</span>
            <span className="cd-onb-cta-arrow">
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
          {error ? (
            <div className="cd-onb-error" role="alert">
              {error}
            </div>
          ) : null}
        </form>
      </div>
    </div>
  );
}
