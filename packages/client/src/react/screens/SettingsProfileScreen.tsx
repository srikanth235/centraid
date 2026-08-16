import { useState } from "react";
import type { CSSProperties, JSX } from "react";

import { IDENTITY_COLORS, identityInitials } from "@centraid/design";

import type { SelfProfile } from "../shell/routes/profileData.js";
import { cx } from "../ui/cx.js";

import a11y from "../styles/a11y.module.css";
import controlsCss from "../styles/controls.module.css";
import drawerGroupCss from "../styles/drawerGroup.module.css";
import styles from "./SettingsProfileScreen.module.css";

/*
 * Settings → Profile: the person, not the device.
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
  const dirty =
    trimmed !== baseline.name || avatarColor !== baseline.avatarColor;
  const ready = trimmed.length > 0 && dirty && !saving;

  const save = (): void => {
    if (!ready) return;
    setSaving(true);
    setStatus(null);
    setFailed(false);
    void onSave({ avatarColor, name: trimmed })
      .then(() => {
        setBaseline({ ...baseline, avatarColor, name: trimmed });
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

  return (
    <div
      className={drawerGroupCss.group}
      style={{ "--profile-accent": avatarColor } as CSSProperties}
    >
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
            <span className={styles.identityWhere}>
              This is how you appear to everyone in this household — on the
              roster, and beside anything you or your devices wrote.
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
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                save();
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
                    setStatus(null);
                  }}
                />
              </label>
            ))}
          </div>
        </div>

        <div className={styles.actions}>
          <button
            type="button"
            className={cx(controlsCss.chip, controlsCss.soft)}
            disabled={!ready}
            onClick={save}
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
          {status ? (
            <span
              className={styles.status}
              data-tone={failed ? "error" : "ok"}
              role={failed ? "alert" : "status"}
            >
              {status}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
