import { useState, type JSX } from 'react';
import styles from './GatewayScreen.module.css';
import { hostFactRows, resolvedKnobRows, type ResourceProfileDTO } from './resource-summary.js';

// L2 of the Resource card (issue #528 Phase B): a collapsed-by-default
// "How we sized this" disclosure over the host facts + resolved knobs.
// Read-only. A controlled button + region (not native <details>) so the
// expand/collapse is deterministic under jsdom, with aria-expanded wired.

export interface ResourceCardDetailsProps {
  profile: ResourceProfileDTO;
}

export default function ResourceCardDetails({ profile }: ResourceCardDetailsProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const host = hostFactRows(profile);
  const knobs = resolvedKnobRows(profile);
  return (
    <div className={styles.resourceDetails}>
      <button
        type="button"
        className={styles.resourceDetailsToggle}
        aria-expanded={open}
        data-testid="resource-details-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <span>How we sized this</span>
        <span className={styles.resourceDetailsChevron} aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open ? (
        <div className={styles.resourceDetailsBody} data-testid="resource-details-body">
          <div className={styles.resourceDetailsGroup}>
            <div className={styles.resourceDetailsGroupTitle}>This host</div>
            <dl className={styles.resourceDetailsList}>
              {host.map((row) => (
                <div key={row.label} className={styles.resourceDetailsRow}>
                  <dt>{row.label}</dt>
                  <dd className={styles.resourceDetailsValue}>{row.value}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className={styles.resourceDetailsGroup}>
            <div className={styles.resourceDetailsGroupTitle}>Resolved settings</div>
            <dl className={styles.resourceDetailsList}>
              {knobs.map((row) => (
                <div key={row.label} className={styles.resourceDetailsRow}>
                  <dt>{row.label}</dt>
                  <dd className={styles.resourceDetailsValue}>{row.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      ) : null}
    </div>
  );
}
