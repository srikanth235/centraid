import { useState } from "react";
import type { CSSProperties, JSX } from "react";

import { IDENTITY_COLORS, identityInitials } from "@centraid/design";

import type { SelfProfile } from "../shell/routes/profileData.js";

import a11y from "../styles/a11y.module.css";
import drawerGroupCss from "../styles/drawerGroup.module.css";
import styles from "./SettingsProfileScreen.module.css";

/*
 * Settings → You, profile group: the person, not the device.
 *
 * Shares its page with the theme group, and saves the same way it does: no
 * Save button. The colour is a discrete pick, so it writes on the pick. The
 * name is free text, so it writes when the field is DONE — blur or Enter, the
 * same commit point the cron field on this page uses — never per keystroke,
 * which would publish half-typed names to the household roster.
 *
 * An empty name is not a save. Clearing the field and leaving restores the
 * name you had: the roster has no "unnamed" state to write, and a blur is not
 * how anyone asks to erase their own name.
 *
 * The name is written to the household ROSTER, which is what makes it visible
 * to anyone else in the installation. Onboarding collects it once, when the
 * member is still carrying the placeholder label; this page is where it is
 * changed afterwards, and the only place the colour can be changed at all.
 */

// The same identity palette as onboarding, native, and kit avatars.
const AVATAR_PALETTE = IDENTITY_COLORS;

export function initials(name: string): string {
  return identityInitials(name);
}

export interface SettingsProfileScreenProps {
  profile: SelfProfile;
  onSave: (input: { name: string; avatarColor: string }) => Promise<void>;
}

export default function SettingsProfileScreen({
  profile,
  onSave,
}: SettingsProfileScreenProps): JSX.Element {
  const [name, setName] = useState(profile.name);
  const [avatarColor, setAvatarColor] = useState(profile.avatarColor);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // The saved values ARE the new baseline. Re-fetching to get one would
  // unmount this form mid-confirmation, so "Saved" would never be readable.
  const [baseline, setBaseline] = useState(profile);

  const trimmed = name.trim();

  // One write for both fields — the roster call carries name AND colour, so a
  // colour pick made while the name field is mid-edit must still send the name
  // that is actually saved, not the half-typed one on screen.
  const commit = (next: { name: string; avatarColor: string }): void => {
    if (
      next.name === baseline.name &&
      next.avatarColor === baseline.avatarColor
    ) {
      return;
    }
    setSaving(true);
    setStatus(null);
    setFailed(false);
    void onSave(next)
      .then(() => {
        setBaseline({ ...baseline, ...next });
        setStatus("Saved");
        setFailed(false);
      })
      .catch((error: unknown) => {
        setFailed(true);
        setStatus(
          `Couldn't save: ${error instanceof Error ? error.message : String(error)}`
        );
      })
      .finally(() => setSaving(false));
  };

  /** Blur or Enter: the point at which a typed name is finished. */
  const commitName = (): void => {
    if (trimmed.length === 0) {
      setName(baseline.name);
      setStatus(null);
      setFailed(false);
      return;
    }
    setName(trimmed);
    commit({ avatarColor, name: trimmed });
  };

  return (
    <div
      className={drawerGroupCss.group}
      style={{ "--profile-accent": avatarColor } as CSSProperties}
    >
      {/* Labelled because this is no longer the whole page: it sits above the
          theme group on Settings → You, so it names which group it is. */}
      <div className={drawerGroupCss.groupLabel}>Profile</div>
      <div className={drawerGroupCss.groupBody}>
        <div className={styles.identity}>
          <span className={styles.avatarWrap}>
            <span className={styles.avatarRing} aria-hidden="true" />
            <span className={styles.avatar} aria-hidden="true">
              <span className={styles.initials}>{initials(name)}</span>
            </span>
          </span>
          <span className={styles.identityText}>
            <span
              className={styles.identityName}
              data-placeholder={trimmed.length === 0 ? "true" : "false"}
            >
              {trimmed || "Unnamed"}
            </span>
            {/* What the roster CURRENTLY holds, not what the field holds: a
                draft commits on blur, so the two differ while it is being
                typed and that difference is the thing worth stating. */}
            <span className={styles.identityWhere}>
              Household sees “{baseline.name}”
            </span>
          </span>
        </div>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Display name</span>
          <input
            className={styles.input}
            type="text"
            value={name}
            maxLength={60}
            autoCapitalize="words"
            autoComplete="name"
            spellCheck={false}
            aria-label="Display name"
            placeholder="Your name"
            onChange={(event) => {
              setName(event.target.value);
              setStatus(null);
            }}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                // Blur rather than commit directly: Enter and clicking away
                // are the same act, so they take the same path exactly once.
                event.currentTarget.blur();
              }
            }}
          />
        </label>

        <div className={styles.field}>
          <span className={styles.fieldLabel} id="cd-profile-color">
            Color
          </span>
          <div
            className={styles.swatches}
            role="radiogroup"
            aria-labelledby="cd-profile-color"
          >
            {AVATAR_PALETTE.map((color) => (
              <label
                key={color}
                className={styles.swatch}
                data-selected={color === avatarColor ? "true" : "false"}
                // `color` drives the selected ring via `currentcolor`, so the
                // ring is always the swatch's own hue.
                style={{ background: color, color }}
              >
                <input
                  type="radio"
                  className={a11y.srControl}
                  name="profile-avatar-color"
                  aria-label={`Color ${color}`}
                  checked={color === avatarColor}
                  onChange={() => {
                    setAvatarColor(color);
                    // A pick is finished the moment it is made — there is no
                    // half-chosen colour to protect anyone from.
                    commit({
                      avatarColor: color,
                      name: trimmed || baseline.name,
                    });
                  }}
                />
              </label>
            ))}
          </div>
        </div>

        {/* Status only — the write already happened. Kept mounted through the
            in-flight moment so a save that fails says so where the button used
            to be, rather than failing silently. */}
        <div className={styles.actions}>
          {saving || status ? (
            <span
              className={styles.status}
              data-tone={failed ? "error" : "ok"}
              role={failed ? "alert" : "status"}
            >
              {saving ? "Saving…" : status}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
