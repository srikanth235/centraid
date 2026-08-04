import { useEffect, useRef } from "react";
import type { JSX } from "react";

import { IDENTITY_COLORS, identityInitials } from "@centraid/design";

import Button from "../ui/Button.js";
import { ErrorNote } from "./OnboardingErrorNote.js";

import a11y from "../styles/a11y.module.css";
import styles from "./OnboardingScreen.module.css";

// Shared identity fills round-trip through updateProfileMetadata, which
// validates #RRGGBB. Keep the palette in design, not in each client.
export const AVATAR_PALETTE = IDENTITY_COLORS;

interface OnboardingIdentityStepProps {
  displayName: string;
  onDisplayName: (value: string) => void;
  avatarColor: string;
  onAvatarColor: (value: string) => void;
  wantsImport: boolean;
  onWantsImport: (value: boolean) => void;
  submitting: boolean;
  /** Shown only on the fresh path, where continuing is the first write. */
  showKeychainNote: boolean;
  error: string | null;
  errorDetail: string | null;
  onContinue: () => void;
  onBack?: (() => void) | undefined;
}

/**
 * The identity step — name, color, and the "I have data to import" choice.
 * Rendered only while the screen is on that step, so mounting is what focuses
 * the field and returning from import re-focuses it.
 */
export function OnboardingIdentityStep({
  displayName,
  onDisplayName,
  avatarColor,
  onAvatarColor,
  wantsImport,
  onWantsImport,
  submitting,
  showKeychainNote,
  error,
  errorDetail,
  onContinue,
  onBack,
}: OnboardingIdentityStepProps): JSX.Element {
  const nameRef = useRef<HTMLInputElement>(null);
  const ready = displayName.trim().length > 0 && !submitting;

  useEffect(() => {
    const id = requestAnimationFrame(() => nameRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <>
      {/* The blurred, 4.2s-pulsing ring around this disc retired with the
          ink-on-paper flip: a glow is not a material this system has, and a
          first-run screen that breathes at you is one that will not sit
          still. What is left is the disc itself — the same round avatar the
          stem foot and the roster will show them from here on. */}
      <div className={styles.avatarWrap}>
        <span
          className={styles.avatar}
          style={{ background: avatarColor }}
          aria-hidden="true"
        >
          <span className={styles.initials}>
            {identityInitials(displayName)}
          </span>
        </span>
      </div>
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          onContinue();
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
          onChange={(e) => onDisplayName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onContinue();
            }
          }}
        />
        <span className={styles.fieldLabel} id="cd-onb-color-label">
          Pick a color
        </span>
        <div
          className={styles.swatches}
          role="radiogroup"
          aria-labelledby="cd-onb-color-label"
        >
          {AVATAR_PALETTE.map((c) => (
            <label
              key={c}
              className={styles.swatch}
              data-color={c}
              data-selected={c === avatarColor ? "true" : "false"}
              style={{ background: c }}
            >
              <input
                type="radio"
                className={a11y.srControl}
                name="onboarding-avatar-color"
                aria-label={`Color ${c}`}
                checked={c === avatarColor}
                onChange={() => onAvatarColor(c)}
              />
            </label>
          ))}
        </div>
        <label className={styles.importChoice}>
          <input
            type="checkbox"
            checked={wantsImport}
            onChange={(event) => onWantsImport(event.target.checked)}
          />
          <span>
            I have data to import
            <small>
              Preview ICS, vCard, CSV, Markdown, MBOX, or Takeout after
              connecting.
            </small>
          </span>
        </label>
        {/* The one primary (M15, `one-primary`) — filled INK, from the shared
            button, not a slab in the member's chosen hue. The hue is theirs
            to wear on the disc and the binding edge; the control that
            commits looks the same for everyone.
            The trailing chevron went with it: a filled primary that is the
            only filled thing on the sheet does not need an arrow to say it
            is the way forward. */}
        <Button
          className={styles.cta}
          label="Continue"
          variant="primary"
          disabled={!ready}
          onClick={onContinue}
        />
        {/* Continue disables the moment the field is empty, and a disabled
            button explains nothing (UX-4). A quiet line says why — not a
            red validation error, because the field starts empty and being
            scolded for not having typed yet is its own small insult. */}
        {displayName.trim().length === 0 ? (
          <p className={styles.hint} data-testid="onboarding-name-hint">
            Add a name to continue — you can change it later in Settings.
          </p>
        ) : null}
        {showKeychainNote ? (
          <p className={styles.keychainNote}>
            Continuing stores this device&rsquo;s keys in your system keychain —
            your OS may ask once to allow it.
          </p>
        ) : null}
        {error ? <ErrorNote summary={error} detail={errorDetail} /> : null}
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
    </>
  );
}
