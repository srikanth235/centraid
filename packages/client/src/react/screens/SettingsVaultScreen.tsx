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

// VaultModal `.prof*` field vocabulary — same chrome as the gateway dialogs (#382).
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
  /** Drop this vault's connection from this device (#665). Remote only. */
  onDisconnect?: () => void;
  /** Encrypted offline copy on this browser. */
  offlineCopy?: boolean;
  /** Resolves with the value that took effect — a refused write is UNCHANGED. */
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
 * Settings → Vault (#382) — active vault presentation only. No Save button:
 * icon/colour write on pick, name/blurb on blur or Enter. Empty name is put
 * back, not saved. Destructive acts stay behind their own confirms.
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
  // After a flip, THEIR answer is truth: `offlineCopy` is a one-shot mount read.
  const [offlineOverride, setOfflineOverride] = useState<boolean | null>(null);
  const [offlineBusy, setOfflineBusy] = useState(false);
  const [erasing, setErasing] = useState(false);
  const offlineOn = offlineOverride ?? offlineCopy === true;
  const flipOffline = (next: boolean): void => {
    if (!onOfflineCopy) return;
    setOfflineBusy(true);
    void onOfflineCopy(next)
      .then((effective) => setOfflineOverride(effective))
      .finally(() => setOfflineBusy(false));
  };

  // Re-seed during render when the active vault changes — never paint old values.
  const [seeded, setSeeded] = useState(vault);
  // Last committed values. Diff against this, not `vault` (that lags the refetch).
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

  // One write for all four fields — a pick must send the last saved text, not a half-edit.
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

  // Disconnect / erase. Confirms stay on the route. Erase absent for a last vault.
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
          {/* Off erases the replica — ask first. Switch never flips optimistically. */}
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
        // Last vault: say why erase is missing, rather than silently omit it.
        <div className={controlsCss.note}>
          This is your only vault here, so it cannot be erased from this page.
        </div>
      )}
    </div>
  );
}
