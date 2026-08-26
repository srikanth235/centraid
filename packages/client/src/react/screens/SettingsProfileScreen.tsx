import { useState } from "react";
import type { CSSProperties, JSX } from "react";

import { IDENTITY_COLORS, identityInitials } from "@centraid/design";

import type { SelfProfile } from "../shell/routes/profileData.js";
import SectionBlock from "../ui/SectionBlock.js";

import a11y from "../styles/a11y.module.css";
import drawerGroupCss from "../styles/drawerGroup.module.css";
import styles from "./SettingsProfileScreen.module.css";

/*
 * Settings → You, profile group: the person, not the device.
 *
 * No Save button: colour writes on the pick; name writes on DONE (blur/
 * Enter), never per keystroke. An empty name is NOT a save — clearing and
 * leaving restores the prior name (the roster has no "unnamed" state).
 */

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
  // Saved values ARE the new baseline; a re-fetch would unmount mid-confirmation.
  const [baseline, setBaseline] = useState(profile);

  const trimmed = name.trim();

  // One write for both fields: send the saved name, not the on-screen draft.
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
      {/* These fields leave this browser; the theme does not. */}
      <SectionBlock label="You" meta="what the household sees" />
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
            {/* The roster's CURRENT value, not the field's pending draft. */}
            <span className={styles.identityWhere}>
              Household sees “{baseline.name}”
            </span>
          </span>
        </div>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Name</span>
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
                // Blur, not direct commit: Enter and clicking away take one path.
                event.currentTarget.blur();
              }
            }}
          />
        </label>

        <div className={styles.field}>
          <span className={styles.fieldLabel} id="cd-profile-color">
            Your colour
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
                // `color` drives the selected ring via `currentcolor`.
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
                    // A pick is finished the moment it is made.
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

        {/* Kept mounted through the in-flight moment so failures are visible. */}
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
