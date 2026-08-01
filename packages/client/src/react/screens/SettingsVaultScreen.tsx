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
 * presentation (name/icon/color/blurb) plus a danger-zone delete. The
 * cross-vault list and the gateway "Connections" group both moved to the
 * switcher, which is the (gateway, vault) pair manager now; this page is
 * scoped to the pair the user is currently in, matching that model.
 */
export default function SettingsVaultScreen({
  vault,
  onSave,
  onDelete,
  onDisconnect,
}: SettingsVaultScreenProps): JSX.Element {
  const [name, setName] = useState(vault.name);
  const [icon, setIcon] = useState<IconName>(vault.icon);
  const [color, setColor] = useState(vault.color);
  const [blurb, setBlurb] = useState(vault.blurb);
  const [saving, setSaving] = useState(false);

  // Re-seed the form when the active vault itself changes (switching vaults
  // while this page is open) — a fresh identity, not a stale edit in flight.
  // Done during render (the React "adjust state when a prop changes" pattern)
  // rather than in an effect, so the new vault never paints through the old
  // vault's field values for a frame.
  const [seeded, setSeeded] = useState(vault);
  if (seeded !== vault) {
    setSeeded(vault);
    setName(vault.name);
    setIcon(vault.icon);
    setColor(vault.color);
    setBlurb(vault.blurb);
  }

  const dirty =
    name.trim() !== vault.name ||
    icon !== vault.icon ||
    color !== vault.color ||
    blurb.trim() !== vault.blurb;
  const ready = name.trim().length > 0;

  const save = (): void => {
    if (!ready || saving) return;
    setSaving(true);
    void Promise.resolve(
      onSave({ blurb: blurb.trim(), color, icon, name: name.trim() })
    ).finally(() => setSaving(false));
  };

  return (
    <div className={drawerGroupCss.group}>
      <div className={drawerGroupCss.groupBody}>
        <div className={controlsCss.note}>
          This vault holds its own apps, conversations, and data. Switch between
          your vaults, or add another, from the switcher at the top of the
          sidebar (⌘⇧G).
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
                onClick={() => setIcon(ic)}
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
                onClick={() => setColor(c)}
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
          />
        </label>

        <button
          type="button"
          className={cx(controlsCss.chip, controlsCss.soft)}
          disabled={!ready || !dirty || saving}
          onClick={save}
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>

      {onDisconnect ? (
        <div className={drawerGroupCss.group}>
          <div className={drawerGroupCss.groupLabel}>On this device</div>
          <div className={drawerGroupCss.groupBody}>
            <div className={controlsCss.note}>
              Stop reaching this vault from this device. It stays intact on its
              host, and you can connect to it again from the switcher.
            </div>
            <button
              type="button"
              className={cx(controlsCss.chip, vaultModalStyles.profModalDelete)}
              onClick={onDisconnect}
            >
              <Icon name="Plug" size={12} />
              Disconnect from this device
            </button>
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
