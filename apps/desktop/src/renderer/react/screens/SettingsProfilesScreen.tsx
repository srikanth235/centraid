import type { CSSProperties, JSX } from 'react';
import { tileFinish } from '@centraid/design-tokens';
import type { IconName } from '@centraid/design-tokens';
import { Icon } from '@centraid/desktop-ui';
import type { ConnectionRowDTO, ProfileRowDTO, SettingsProfilesBridgeProps } from '../bridge.js';

function Avatar({
  icon,
  color,
  size = 40,
}: {
  icon: string;
  color: string;
  size?: number;
}): JSX.Element {
  const finish = tileFinish(color, 'gradient');
  const style: CSSProperties = {
    width: size,
    height: size,
    flexShrink: 0,
    borderRadius: Math.max(6, Math.round(size * 0.28)),
    display: 'grid',
    placeItems: 'center',
    background: finish.background,
    boxShadow: finish.boxShadow,
    color: finish.glyphColor,
  };
  return (
    <span aria-hidden="true" style={style}>
      <Icon name={icon as IconName} size={Math.round(size * 0.52)} strokeWidth={1.9} />
    </span>
  );
}

function ProfileRow({
  p,
  onSwitch,
  onEdit,
  onDelete,
}: {
  p: ProfileRowDTO;
  onSwitch: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}): JSX.Element {
  return (
    <div className="cd-prof-row" data-active={p.active ? 'true' : 'false'}>
      <Avatar icon={p.icon} color={p.color} size={40} />
      <div className="cd-prof-row-text">
        <div className="cd-prof-row-titlerow">
          <span className="cd-prof-row-name">{p.name}</span>
          {p.active ? <span className="cd-prof-row-badge">Active</span> : null}
        </div>
        <div className="cd-prof-row-sub">{p.subLine}</div>
      </div>
      <div className="cd-prof-row-actions">
        {!p.active ? (
          <button
            type="button"
            className="cd-chip cd-prof-row-switch"
            onClick={() => onSwitch(p.id)}
          >
            Switch
          </button>
        ) : null}
        <button
          type="button"
          className="cd-icon-btn"
          title="Edit"
          aria-label={`Edit ${p.name}`}
          onClick={() => onEdit(p.id)}
        >
          <Icon name="Pencil" size={13} />
        </button>
        {!p.primordial ? (
          <button
            type="button"
            className="cd-icon-btn cd-prof-row-del"
            title="Delete"
            aria-label={`Delete ${p.name}`}
            onClick={() => onDelete(p.id)}
          >
            <Icon name="Trash" size={13} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ConnectionRow({
  c,
  onConnect,
  onRemove,
}: {
  c: ConnectionRowDTO;
  onConnect: (id: string) => void;
  onRemove: (id: string) => void;
}): JSX.Element {
  return (
    <div className="cd-prof-row" data-active={c.active ? 'true' : 'false'}>
      <div className="cd-prof-row-text">
        <div className="cd-prof-row-titlerow">
          <span className="cd-prof-row-name">{c.displayName}</span>
          {c.active ? <span className="cd-prof-row-badge">Connected</span> : null}
        </div>
        <div className="cd-prof-row-sub">{c.sub}</div>
      </div>
      <div className="cd-prof-row-actions">
        {!c.active ? (
          <button
            type="button"
            className="cd-chip cd-prof-row-switch"
            onClick={() => onConnect(c.id)}
          >
            Connect
          </button>
        ) : null}
        {c.removable ? (
          <button
            type="button"
            className="cd-icon-btn cd-prof-row-del"
            title="Remove connection"
            aria-label={`Remove ${c.displayName}`}
            onClick={() => onRemove(c.id)}
          >
            <Icon name="Trash" size={13} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Settings → Spaces page, ported to React (issue #325, Phase 3). Space
 * (vault-backed profile) cards with switch/edit/delete + add, and the gateway
 * connections list. The vanilla side owns the modals + gateway I/O (all through
 * the callbacks); React renders. Same `cd-prof-*` classes.
 */
export default function SettingsProfilesScreen({
  profiles,
  connections,
  onSwitch,
  onEdit,
  onDelete,
  onAdd,
  onConnect,
  onRemoveConnection,
}: SettingsProfilesBridgeProps): JSX.Element {
  return (
    <>
      <div className="drawer-group">
        <div className="drawer-group-label">Spaces</div>
        <div className="drawer-group-body">
          <div className="settings-note">
            Each space is a vault — its own apps, chats, and data, deny-by-default to every app
            until you grant access. Switch from here or from the switcher at the top of the sidebar
            (⌘⇧G).
          </div>
          <div className="cd-prof-manage">
            <div className="cd-prof-manage-list">
              {profiles.map((p) => (
                <ProfileRow
                  key={p.id}
                  p={p}
                  onSwitch={onSwitch}
                  onEdit={onEdit}
                  onDelete={onDelete}
                />
              ))}
            </div>
            <button type="button" className="cd-prof-manage-add" onClick={onAdd}>
              <span>
                <Icon name="Plus" size={14} />
              </span>
              Add profile
            </button>
          </div>
        </div>
      </div>

      <div className="drawer-group">
        <div className="drawer-group-label">Connections</div>
        <div className="drawer-group-body">
          <div className="settings-note">
            Gateways this desktop can talk to. Each connection hosts its own set of spaces.
          </div>
          <div className="cd-prof-manage-list">
            {connections.map((c) => (
              <ConnectionRow key={c.id} c={c} onConnect={onConnect} onRemove={onRemoveConnection} />
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
