import { type CSSProperties, type JSX, useEffect, useState } from 'react';
import type { IconName } from '@centraid/design-tokens';
import { Icon } from '../ui/index.js';
import { cx } from '../ui/cx.js';
import controlsCss from '../styles/controls.module.css';
import drawerGroupCss from '../styles/drawerGroup.module.css';
// Reuses SpaceModal's field vocabulary (`.prof*`) directly — same precedent
// GatewayModal.tsx / ConnectFlowModal.tsx / RenameGatewayModal.tsx set for
// the shared dialog chrome, extended here to a plain (non-modal) form
// section so name/icon/color/blurb edits look identical everywhere they
// appear (issue #382).
import spaceModalStyles from '../shell/routes/SpaceModal.module.css';
import { PROFILE_COLORS, PROFILE_ICONS } from '../shell/routes/SpaceModal.js';
import type { ActiveSpaceData } from '../shell/routes/settingsAccountData.js';

export interface SettingsSpaceScreenProps {
  space: ActiveSpaceData;
  onSave: (data: {
    name: string;
    icon: IconName;
    color: string;
    blurb: string;
  }) => Promise<void> | void;
  onDelete?: () => void;
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
          alignItems: 'center',
          borderRadius: 12,
          color: 'white',
          display: 'inline-flex',
          justifyContent: 'center',
        } as CSSProperties
      }
    >
      <span
        style={
          {
            background: color,
            borderRadius: 12,
            display: 'grid',
            height: size,
            placeItems: 'center',
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
 * Settings → Space (issue #382) — edits ONLY the active vault's
 * presentation (name/icon/color/blurb) plus a danger-zone delete. The
 * cross-vault list and the gateway "Connections" group both moved to the
 * switcher, which is the (gateway, vault) pair manager now; this page is
 * scoped to the pair the user is currently in, matching that model.
 */
export default function SettingsSpaceScreen({
  space,
  onSave,
  onDelete,
}: SettingsSpaceScreenProps): JSX.Element {
  const [name, setName] = useState(space.name);
  const [icon, setIcon] = useState<IconName>(space.icon);
  const [color, setColor] = useState(space.color);
  const [blurb, setBlurb] = useState(space.blurb);
  const [saving, setSaving] = useState(false);

  // Re-seed the form when the active vault itself changes (switching spaces
  // while this page is open) — a fresh identity, not a stale edit in flight.
  useEffect(() => {
    setName(space.name);
    setIcon(space.icon);
    setColor(space.color);
    setBlurb(space.blurb);
  }, [space]);

  const dirty =
    name.trim() !== space.name ||
    icon !== space.icon ||
    color !== space.color ||
    blurb.trim() !== space.blurb;
  const ready = name.trim().length > 0;

  const save = (): void => {
    if (!ready || saving) return;
    setSaving(true);
    void Promise.resolve(onSave({ blurb: blurb.trim(), color, icon, name: name.trim() })).finally(
      () => setSaving(false),
    );
  };

  return (
    <div className={drawerGroupCss.group}>
      <div className={drawerGroupCss.groupBody}>
        <div className={controlsCss.note}>
          This space is a vault — its own apps, chats, and data. Switch, add, or manage other spaces
          from the switcher at the top of the sidebar (⌘⇧G).
        </div>

        <div className={spaceModalStyles.profModalPreview}>
          <span>
            <Avatar icon={icon} color={color} size={46} />
          </span>
          <div className={spaceModalStyles.profModalPreviewText}>
            <div className={spaceModalStyles.profModalPreviewName}>{name.trim() || 'Untitled'}</div>
            <div className={spaceModalStyles.profModalPreviewSub}>
              {blurb.trim() || 'How this space appears in the switcher.'}
            </div>
          </div>
        </div>

        <label className={spaceModalStyles.profField}>
          <span className={spaceModalStyles.profFieldLabel}>Name</span>
          <input
            className={spaceModalStyles.profFieldInput}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label className={spaceModalStyles.profField}>
          <span className={spaceModalStyles.profFieldLabel}>Icon</span>
          <div className={spaceModalStyles.profIconGrid}>
            {PROFILE_ICONS.map((ic) => (
              <button
                key={ic}
                type="button"
                className={spaceModalStyles.profIconBtn}
                title={ic}
                aria-label={ic}
                data-selected={ic === icon ? 'true' : 'false'}
                onClick={() => setIcon(ic)}
              >
                <Icon name={ic} size={16} />
              </button>
            ))}
          </div>
        </label>

        <label className={spaceModalStyles.profField}>
          <span className={spaceModalStyles.profFieldLabel}>Color</span>
          <div className={spaceModalStyles.profColorRow}>
            {PROFILE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={spaceModalStyles.profColorBtn}
                title={c}
                aria-label={`Color ${c}`}
                data-selected={c === color ? 'true' : 'false'}
                style={{ background: c }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
        </label>

        <label className={spaceModalStyles.profField}>
          <span className={spaceModalStyles.profFieldLabel}>
            Description<span className={spaceModalStyles.profFieldOptional}>optional</span>
          </span>
          <input
            className={spaceModalStyles.profFieldInput}
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
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>

      {onDelete ? (
        <div className={drawerGroupCss.group}>
          <div className={drawerGroupCss.groupLabel}>Danger zone</div>
          <div className={drawerGroupCss.groupBody}>
            <div className={controlsCss.note}>
              Delete this space — its vault and everything in it are removed. This can't be undone.
            </div>
            <button
              type="button"
              className={cx(controlsCss.chip, spaceModalStyles.profModalDelete)}
              onClick={onDelete}
            >
              <Icon name="Trash" size={12} />
              Delete this space
            </button>
          </div>
        </div>
      ) : (
        <div className={controlsCss.note}>
          This is the only space on this gateway, so it can't be deleted from here.
        </div>
      )}
    </div>
  );
}
