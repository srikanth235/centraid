import { useState } from "react";
import type { CSSProperties, JSX } from "react";

import type { IconName } from "@centraid/design";

import type { ActiveVaultData } from "../shell/routes/settingsAccountData.js";
import { PROFILE_COLORS, PROFILE_ICONS } from "../shell/routes/VaultModal.js";
import { cx } from "../ui/cx.js";
import { Icon } from "../ui/index.js";

// Reuses VaultModal's field vocabulary (`.prof*`) directly — same precedent
// GatewayModal.tsx / ConnectFlowModal.tsx / RenameGatewayModal.tsx set for
// the shared dialog chrome, extended here to a plain (non-modal) form
// section so name/icon/color/blurb edits look identical everywhere they
// appear (issue #382).
import vaultModalStyles from "../shell/routes/VaultModal.module.css";
import controlsCss from "../styles/controls.module.css";
import drawerGroupCss from "../styles/drawerGroup.module.css";
import styles from "./SettingsVaultScreen.module.css";

export interface SettingsVaultScreenProps {
  vault: ActiveVaultData;
  onSave: (data: {
    name: string;
    icon: IconName;
    color: string;
    blurb: string;
  }) => Promise<void> | void;
  onDelete?: () => void;
  /** Drop this vault's connection from this device (issue #665). Present only
   *  for a vault on a REMOTE connection — the local host is this machine. */
  onDisconnect?: () => void;
  /**
   * Whether this browser keeps an encrypted offline copy of the vault.
   *
   * It lived on a "This device" settings page until that page was retired: the
   * page's other rows all duplicated the stem's account menu, and this switch
   * was the only thing on it with nowhere else to be. "On this device" below is
   * where it belongs anyway — the same group that already answers "what does
   * this browser hold, and how do I stop holding it".
   */
  offlineCopy?: boolean;
  /** Flip the offline copy. Resolves with the value that actually took effect
   *  — a refused or failed write comes back as the UNCHANGED value, so the
   *  switch can never show a state the device is not in. */
  onOfflineCopy?: (next: boolean) => Promise<boolean>;
}

function Avatar({
  icon,
  color,
  size,
}: {
  icon: IconName;
  color: string;
  size: number;
}): JSX.Element {
  return (
    <span
      style={
        {
          alignItems: "center",
          borderRadius: 12,
          color: "white",
          display: "inline-flex",
          justifyContent: "center",
        } as CSSProperties
      }
    >
      <span
        style={
          {
            background: color,
            borderRadius: 12,
            display: "grid",
            height: size,
            placeItems: "center",
            width: size,
          } as CSSProperties
        }
      >
        <Icon name={icon} size={Math.round(size * 0.42)} strokeWidth={1.7} />
      </span>
    </span>
  );
}

/**
 * Settings → Vault (issue #382) — edits ONLY the active vault's
 * presentation (name/icon/color/blurb) plus a danger-zone delete.
 *
 * Nothing here has a Save button: icon and colour write on the pick, name and
 * description on blur or Enter, and the route answers with its own toast. An
 * emptied name is put back rather than saved — an untitled vault is not a
 * state the switcher can show. The destructive controls below are the
 * exception by design, and stay explicit acts behind their own confirms.
 * The
 * cross-vault list and the gateway "Connections" group both moved to the
 * switcher, which is the (gateway, vault) pair manager now; this page is
 * scoped to the pair the user is currently in, matching that model.
 */
export default function SettingsVaultScreen({
  vault,
  onSave,
  onDelete,
  onDisconnect,
  offlineCopy,
  onOfflineCopy,
}: SettingsVaultScreenProps): JSX.Element {
  const [name, setName] = useState(vault.name);
  const [icon, setIcon] = useState<IconName>(vault.icon);
  const [color, setColor] = useState(vault.color);
  const [blurb, setBlurb] = useState(vault.blurb);
  // Once the user has flipped the switch, THEIR answer is the truth on screen:
  // the `offlineCopy` prop is a one-shot read from mount (`loadThisDeviceData`)
  // and does not re-run, so letting it win back would flip the switch under
  // them on the next render.
  const [offlineOverride, setOfflineOverride] = useState<boolean | null>(null);
  const [offlineBusy, setOfflineBusy] = useState(false);
  const offlineOn = offlineOverride ?? offlineCopy === true;
  const flipOffline = (next: boolean): void => {
    if (!onOfflineCopy) return;
    setOfflineBusy(true);
    void onOfflineCopy(next)
      .then((effective) => setOfflineOverride(effective))
      .finally(() => setOfflineBusy(false));
  };

  // Re-seed the form when the active vault itself changes (switching vaults
  // while this page is open) — a fresh identity, not a stale edit in flight.
  // Done during render (the React "adjust state when a prop changes" pattern)
  // rather than in an effect, so the new vault never paints through the old
  // vault's field values for a frame.
  const [seeded, setSeeded] = useState(vault);
  // What the vault was last told to be. Every field writes on its own now, so
  // a save needs something to be "changed" AGAINST that is not the `vault`
  // prop — that prop only catches up after the route refetches, and until it
  // does, every later edit would look like a change to the pre-save value and
  // re-send fields nobody touched.
  const [sent, setSent] = useState({
    blurb: vault.blurb,
    color: vault.color,
    icon: vault.icon,
    name: vault.name,
  });
  if (seeded !== vault) {
    setSeeded(vault);
    setName(vault.name);
    setIcon(vault.icon);
    setColor(vault.color);
    setBlurb(vault.blurb);
    setSent({
      blurb: vault.blurb,
      color: vault.color,
      icon: vault.icon,
      name: vault.name,
    });
  }

  // One write for the whole presentation — `onSave` carries all four fields,
  // so picking an icon has to send the name that is actually saved rather than
  // whatever a half-edited field currently holds.
  const commit = (next: {
    name: string;
    icon: IconName;
    color: string;
    blurb: string;
  }): void => {
    if (
      next.name === sent.name &&
      next.icon === sent.icon &&
      next.color === sent.color &&
      next.blurb === sent.blurb
    ) {
      return;
    }
    setSent(next);
    void Promise.resolve(onSave(next));
  };

  /** The current values, with any half-edited text field standing at its last
   *  saved value — what a pick (icon, colour) should send alongside itself. */
  const settled = (): {
    name: string;
    icon: IconName;
    color: string;
    blurb: string;
  } => ({
    blurb: blurb.trim(),
    color,
    icon,
    name: name.trim() || sent.name,
  });

  /** Blur or Enter on a text field: the point at which typing is finished. A
   *  vault with no name is not a state to write, so an emptied field is put
   *  back rather than saved. */
  const commitText = (): void => {
    if (name.trim().length === 0) {
      setName(sent.name);
    } else {
      setName(name.trim());
    }
    setBlurb(blurb.trim());
    commit(settled());
  };

  return (
    <div className={drawerGroupCss.group}>
      <div className={drawerGroupCss.groupBody}>
        <div className={controlsCss.note}>
          This vault holds its own apps, conversations, and data.
        </div>

        <div className={vaultModalStyles.profModalPreview}>
          <span>
            <Avatar icon={icon} color={color} size={46} />
          </span>
          <div className={vaultModalStyles.profModalPreviewText}>
            <div className={vaultModalStyles.profModalPreviewName}>
              {name.trim() || "Untitled"}
            </div>
            <div className={vaultModalStyles.profModalPreviewSub}>
              {blurb.trim() || "How this vault appears in the switcher."}
            </div>
          </div>
        </div>

        <label className={vaultModalStyles.profField}>
          <span className={vaultModalStyles.profFieldLabel}>Name</span>
          <input
            className={vaultModalStyles.profFieldInput}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitText}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
          />
        </label>

        <label className={vaultModalStyles.profField}>
          <span className={vaultModalStyles.profFieldLabel}>Icon</span>
          <div className={vaultModalStyles.profIconGrid}>
            {PROFILE_ICONS.map((ic) => (
              <button
                key={ic}
                type="button"
                className={vaultModalStyles.profIconBtn}
                title={ic}
                aria-label={ic}
                data-selected={ic === icon ? "true" : "false"}
                onClick={() => {
                  setIcon(ic);
                  commit({ ...settled(), icon: ic });
                }}
              >
                <Icon name={ic} size={16} />
              </button>
            ))}
          </div>
        </label>

        <label className={vaultModalStyles.profField}>
          <span className={vaultModalStyles.profFieldLabel}>Color</span>
          <div className={vaultModalStyles.profColorRow}>
            {PROFILE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={vaultModalStyles.profColorBtn}
                title={c}
                aria-label={`Color ${c}`}
                data-selected={c === color ? "true" : "false"}
                style={{ background: c }}
                onClick={() => {
                  setColor(c);
                  commit({ ...settled(), color: c });
                }}
              />
            ))}
          </div>
        </label>

        <label className={vaultModalStyles.profField}>
          <span className={vaultModalStyles.profFieldLabel}>
            Description
            <span className={vaultModalStyles.profFieldOptional}>optional</span>
          </span>
          <input
            className={vaultModalStyles.profFieldInput}
            type="text"
            placeholder="A short note — e.g. Focus & planning"
            value={blurb}
            onChange={(e) => setBlurb(e.target.value)}
            onBlur={commitText}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
          />
        </label>
      </div>

      {onOfflineCopy || onDisconnect ? (
        <div className={drawerGroupCss.group}>
          <div className={drawerGroupCss.groupLabel}>On this device</div>
          <div className={drawerGroupCss.groupBody}>
            {onOfflineCopy ? (
              <label className={styles.offlineRow} data-on={offlineOn}>
                <input
                  type="checkbox"
                  aria-label="Keep an offline copy"
                  checked={offlineOn}
                  disabled={offlineBusy}
                  onChange={(event) => flipOffline(event.target.checked)}
                />
                <span>
                  <strong>Keep an offline copy</strong>
                  <small>
                    An encrypted replica, queued changes, and cached previews
                    stay on this device, so it keeps working on a bad
                    connection. Turning this off erases them here and leaves
                    only the pairing.
                  </small>
                </span>
              </label>
            ) : null}
            {onDisconnect ? (
              <>
                <div className={controlsCss.note}>
                  Stop reaching this vault from this device — it stays intact on
                  its host.
                </div>
                <button
                  type="button"
                  className={cx(
                    controlsCss.chip,
                    vaultModalStyles.profModalDelete
                  )}
                  onClick={onDisconnect}
                >
                  <Icon name="Plug" size={12} />
                  Disconnect from this device
                </button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {onDelete ? (
        <div className={drawerGroupCss.group}>
          <div className={drawerGroupCss.groupLabel}>Danger zone</div>
          <div className={drawerGroupCss.groupBody}>
            <div className={controlsCss.note}>
              Erase this vault and everything in it, everywhere — not just on
              this device. This can’t be undone.
            </div>
            <button
              type="button"
              className={cx(controlsCss.chip, vaultModalStyles.profModalDelete)}
              onClick={onDelete}
            >
              <Icon name="Trash" size={12} />
              Erase this vault
            </button>
          </div>
        </div>
      ) : (
        <div className={controlsCss.note}>
          This is your only vault here, so it can’t be deleted from this page.
        </div>
      )}
    </div>
  );
}
