import { type JSX, useState } from 'react';
import ScopePicker from './ScopePicker.js';
import type { MemberScope } from '../memberScope.js';
import styles from './ScopePicker.module.css';
import buttonCss from '../../ui/Button.module.css';

// "Where should this app live?" — the builder's target picker (issue #599,
// Decision 14).
//
// The builder creates its app the moment it mounts, so there is no point in the
// running builder at which a member could still choose. The choice therefore
// happens BEFORE the builder mounts, on this one-question gate. With a single
// writable space there is nothing to ask, so the caller skips the gate entirely
// and the flow is byte-for-byte what it was before the picker existed.

export interface BuilderTargetGateProps {
  scopes: MemberScope[];
  /** Preselected: the member's own space, never the last one used. */
  defaultScopeId: string | undefined;
  onConfirm: (scopeId: string) => void;
  onCancel: () => void;
}

export default function BuilderTargetGate({
  scopes,
  defaultScopeId,
  onConfirm,
  onCancel,
}: BuilderTargetGateProps): JSX.Element {
  const [picked, setPicked] = useState<string | undefined>(defaultScopeId);
  const target = picked ?? defaultScopeId ?? scopes.find((s) => s.canWrite)?.id;
  return (
    <div className={styles.gate} aria-label="Choose where this app lives">
      <div className={styles.gateBody}>
        <h2 className={styles.gateTitle}>Where should this app live?</h2>
        <p className={styles.gateText}>
          Everything it stores goes into this space, and the people who can reach that space can
          reach the app.
        </p>
        <ScopePicker scopes={scopes} value={target} onChange={setPicked} label="Build it in" />
        <div className={styles.gateActions}>
          <button type="button" className={buttonCss.ghost} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={buttonCss.primary}
            disabled={!target}
            onClick={() => target && onConfirm(target)}
          >
            Start building
          </button>
        </div>
      </div>
    </div>
  );
}
