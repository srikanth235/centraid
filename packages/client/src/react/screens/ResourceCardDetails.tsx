import { useState } from "react";
import type { JSX } from "react";

import { hostFactRows, resolvedKnobRows } from "./resource-summary.js";
import type { ResourceProfileDTO } from "./resource-summary.js";

import styles from "./GatewayScreen.module.css";

export interface ResourceCardDetailsProps {
  profile: ResourceProfileDTO;
  embedded?: boolean;
}

function DetailGroups({
  profile,
}: {
  profile: ResourceProfileDTO;
}): JSX.Element {
  const host = hostFactRows(profile);
  const knobs = resolvedKnobRows(profile);
  return (
    <div
      className={styles.resourceDetailsBody}
      data-testid="resource-details-body"
    >
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
        <div className={styles.resourceDetailsGroupTitle}>
          Resolved settings
        </div>
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
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open ? <DetailGroups profile={profile} /> : null}
    </div>
  );
}
