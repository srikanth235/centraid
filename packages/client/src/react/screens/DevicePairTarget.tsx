import type { JSX } from 'react';
import type { GatewayDeviceRole, GatewayMember } from '../../gateway-client.js';
import { cx } from '../ui/cx.js';
import { DEFAULT_ROLE, ROLE_PRESETS } from './device-roles.js';
import styles from './DevicePairPanel.module.css';

/*
 * Who the ticket is for, and what it lets them reach (issue #599 Decision 10).
 *
 * The person is picked from a LIST — existing members plus "New person…" —
 * never typed into a bare text field. Free text is a revocation gap, not a
 * typo risk: "priya" next to "Priya" is a second member who quietly survives
 * "remove Priya" holding live access. The one text input here appears only
 * after "New person…" is chosen, and the gateway creates that member itself.
 *
 * Access is authored per SPACE, because the fence against role sprawl is
 * narrower spaces rather than finer roles: the kid who may edit Shared Lists
 * but only view Family Photos gets two rows here, not a fourth role tier.
 */

/** The person a ticket is being minted for. */
export type PairTarget =
  | { kind: 'self' }
  | { kind: 'member'; memberId: string }
  | { kind: 'new'; label: string };

const NEW_PERSON_VALUE = '__new__';
const SELF_VALUE = '__self__';

export interface PairGrant {
  vaultId: string;
  role: GatewayDeviceRole;
}

export interface PairSpace {
  vaultId: string;
  vaultName?: string;
}

export interface DevicePairTargetProps {
  target: PairTarget;
  onTargetChange: (target: PairTarget) => void;
  members: readonly GatewayMember[];
  /** The caller's own member id — the row rendered as "For myself". */
  currentMemberId?: string;
  spaces: readonly PairSpace[];
  grants: readonly PairGrant[];
  onGrantsChange: (grants: PairGrant[]) => void;
  disabled: boolean;
}

function spaceLabel(space: PairSpace): string {
  return space.vaultName ?? space.vaultId;
}

export default function DevicePairTarget({
  target,
  onTargetChange,
  members,
  currentMemberId,
  spaces,
  grants,
  onGrantsChange,
  disabled,
}: DevicePairTargetProps): JSX.Element {
  // "For myself" is its own option rather than the caller's own row, so the
  // default state can never be read as "pairing a device for that person".
  const others = members.filter((member) => member.memberId !== currentMemberId);
  const selected =
    target.kind === 'self'
      ? SELF_VALUE
      : target.kind === 'new'
        ? NEW_PERSON_VALUE
        : target.memberId;

  const setSelected = (value: string): void => {
    if (value === SELF_VALUE) return onTargetChange({ kind: 'self' });
    if (value === NEW_PERSON_VALUE) return onTargetChange({ kind: 'new', label: '' });
    onTargetChange({ kind: 'member', memberId: value });
  };

  const grantFor = (vaultId: string): PairGrant | undefined =>
    grants.find((grant) => grant.vaultId === vaultId);

  const toggleSpace = (vaultId: string, on: boolean): void => {
    onGrantsChange(
      on
        ? [...grants, { vaultId, role: DEFAULT_ROLE }]
        : grants.filter((grant) => grant.vaultId !== vaultId),
    );
  };

  const setRole = (vaultId: string, role: GatewayDeviceRole): void => {
    onGrantsChange(grants.map((grant) => (grant.vaultId === vaultId ? { vaultId, role } : grant)));
  };

  return (
    <div className={styles.pairTarget}>
      <label className={styles.pairField}>
        <span className={styles.pairFieldLabel}>Pair a device for</span>
        <select
          className={styles.pairSelect}
          value={selected}
          disabled={disabled}
          onChange={(event) => setSelected(event.target.value)}
        >
          <option value={SELF_VALUE}>Myself</option>
          {others.map((member) => (
            <option key={member.memberId} value={member.memberId}>
              {member.label}
            </option>
          ))}
          <option value={NEW_PERSON_VALUE}>New person…</option>
        </select>
      </label>

      {target.kind === 'new' ? (
        <label className={styles.pairField}>
          <span className={styles.pairFieldLabel}>Their name</span>
          <input
            className={styles.pairInput}
            type="text"
            value={target.label}
            placeholder="e.g. Priya"
            disabled={disabled}
            onChange={(event) => onTargetChange({ kind: 'new', label: event.target.value })}
          />
        </label>
      ) : null}

      {target.kind === 'self' ? (
        <p className={styles.roleHint}>
          The new device joins as you, with your current access. Nothing you can’t already reach.
        </p>
      ) : (
        <fieldset className={styles.grantGroup}>
          <legend className={styles.pairFieldLabel}>What they may reach</legend>
          {spaces.length === 0 ? (
            <p className={styles.roleHint}>No spaces available to share.</p>
          ) : (
            spaces.map((space) => {
              const grant = grantFor(space.vaultId);
              return (
                <div key={space.vaultId} className={styles.grantRow}>
                  <label className={styles.grantCheck}>
                    <input
                      type="checkbox"
                      checked={grant !== undefined}
                      disabled={disabled}
                      onChange={(event) => toggleSpace(space.vaultId, event.target.checked)}
                    />
                    <span>{spaceLabel(space)}</span>
                  </label>
                  <fieldset className={styles.ttlGroup} aria-label={`Role in ${spaceLabel(space)}`}>
                    {ROLE_PRESETS.map((preset) => (
                      <button
                        key={preset.role}
                        type="button"
                        className={cx(
                          styles.ttlPreset,
                          grant?.role === preset.role && styles.ttlPresetOn,
                        )}
                        aria-pressed={grant?.role === preset.role}
                        disabled={disabled || grant === undefined}
                        title={preset.hint}
                        onClick={() => setRole(space.vaultId, preset.role)}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </fieldset>
                </div>
              );
            })
          )}
        </fieldset>
      )}
    </div>
  );
}
