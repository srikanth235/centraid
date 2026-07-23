import { useState, type JSX } from 'react';
import styles from './GatewayScreen.module.css';
import { hostFactRows, resolvedKnobRows, type ResourceProfileDTO } from './resource-summary.js';

// L2 of the Resource card (issue #528 Phase B): the host facts + resolved knobs
// behind "How we sized this". Read-only. Two render modes:
//   - default: a collapsed-by-default disclosure (controlled button + region,
//     not native <details>, so expand/collapse is deterministic under jsdom).
//   - embedded: always-open groups with no toggle — for use inside the
//     "How we sized this" dialog (issue #528 follow-up), which supplies its
//     own heading and dismissal.

export interface ResourceCardDetailsProps {
  profile: ResourceProfileDTO;
  /** Render open with no toggle, for the details dialog. */
  embedded?: boolean;
}

function DetailGroups({ profile }: { profile: ResourceProfileDTO }): JSX.Element {
  const host = hostFactRows(profile);
  const knobs = resolvedKnobRows(profile);
  return (
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
  );
}

export default function ResourceCardDetails({
  profile,
  embedded = false,
}: ResourceCardDetailsProps): JSX.Element {
  const [open, setOpen] = useState(false);

  if (embedded) {
    return <DetailGroups profile={profile} />;
  }

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
      {open ? <DetailGroups profile={profile} /> : null}
    </div>
  );
}
