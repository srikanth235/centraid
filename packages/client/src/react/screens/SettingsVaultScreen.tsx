import { useState } from "react";
import type { CSSProperties, JSX } from "react";

import type { IconName } from "@centraid/design";

import type { ActiveVaultData } from "../shell/routes/settingsAccountData.js";
import { PROFILE_COLORS, PROFILE_ICONS } from "../shell/routes/VaultModal.js";
import { Icon } from "../ui/index.js";
import PanelBlock from "../ui/PanelBlock.js";
import RowsBlock from "../ui/RowsBlock.js";
import type { RowDef } from "../ui/RowsBlock.js";
import SectionBlock from "../ui/SectionBlock.js";

// Reuses VaultModal's field vocabulary (`.prof*`) directly — same precedent
// GatewayModal.tsx / ConnectFlowModal.tsx / RenameGatewayModal.tsx set for
// the shared dialog chrome, extended here to a plain (non-modal) form
// section so name/icon/color/blurb edits look identical everywhere they
// appear (#382).
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
  /** Drop this vault's connection from this device (#665). Present only
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
 * Settings → Vault (#382) — edits ONLY the active vault's
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
  /** The confirm that stands between the switch and an erased local copy. */
  const [erasing, setErasing] = useState(false);
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
  // LEAVING — the two acts that end this device's relationship with the vault,
  // or the vault. Both keep the confirms the route already owns: disconnect
  // names every sibling vault on the connection, erase asks for the name typed
  // back. Erase is absent for a last vault rather than offered and refused.
  const leaving: RowDef[] = [
    ...(onDisconnect
      ? [
          {
            id: "disconnect",
            title: "Disconnect from this device",
            sub: "Connection-wide · the vault stays on its host",
            dangerous: true,
            action: { label: "Disconnect", onClick: onDisconnect },
          } satisfies RowDef,
        ]
      : []),
    ...(onDelete
      ? [
          {
            id: "erase",
            title: "Erase this vault",
            sub: "Everywhere · never for your last vault",
            dangerous: true,
            action: { label: "Erase", onClick: onDelete },
          } satisfies RowDef,
        ]
      : []),
  ];

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
      <SectionBlock label="This vault" meta="the active one" />
      <div className={drawerGroupCss.groupBody}>
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

      {onOfflineCopy ? (
        <>
          <SectionBlock label="Copies" meta="on this browser" />
          {/* TURNING IT OFF ERASES SOMETHING, so it asks first, in the words of
              what goes. The switch itself never optimistically flips: it shows
              what the device is actually in, and `flipOffline` resolves with
              the value that took effect. */}
          {erasing ? (
            <PanelBlock
              wide
              tone="net"
              eyebrow="Stop keeping a copy"
              title="The local copy is erased"
              body="The encrypted replica, any queued changes and the cached previews go — the pairing stays."
              action={{
                label: "Erase it",
                dangerous: true,
                onClick: () => {
                  setErasing(false);
                  flipOffline(false);
                },
              }}
              action2={{ label: "Keep it", onClick: () => setErasing(false) }}
            />
          ) : null}
          <label className={styles.offlineRow} data-on={offlineOn}>
            <input
              type="checkbox"
              aria-label="Keep an offline copy"
              checked={offlineOn}
              disabled={offlineBusy}
              onChange={(event) => {
                if (event.target.checked) flipOffline(true);
                else setErasing(true);
              }}
            />
            <span>
              <strong>Keep an offline copy</strong>
              <small>
                {offlineOn
                  ? "Encrypted replica, queued changes, cached previews."
                  : "Nothing is held locally."}
              </small>
            </span>
          </label>
        </>
      ) : null}

      {leaving.length > 0 ? (
        <>
          <SectionBlock
            label="Leaving"
            meta={leaving.length > 1 ? "both irreversible" : "irreversible"}
          />
          <RowsBlock ariaLabel="Leaving" rows={leaving} />
        </>
      ) : null}
      {onDelete ? null : (
        // Never offered for the last vault — and said, rather than silently
        // absent, because a member looking for it needs to know why it is not
        // there.
        <div className={controlsCss.note}>
          This is your only vault here, so it cannot be erased from this page.
        </div>
      )}
    </div>
  );
}
