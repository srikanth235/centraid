import { useEffect, useRef, type JSX } from 'react';
import styles from './ResourceDialogs.module.css';
import ResourceCardDetails from './ResourceCardDetails.js';
import ResourceAdvancedKnobs from './ResourceAdvancedKnobs.js';
import type { ResourceKnobPrefs, ResourceProfileDTO, TunableKnobKey } from './resource-summary.js';

// "How we sized this" dialog (issue #528 follow-up): the L2 host facts +
// resolved knobs (ResourceCardDetails, embedded) and the L3 owner-tunable knobs
// (ResourceAdvancedKnobs), lifted out of the card body into a focused sheet so
// the card itself stays a compact choose-and-glance surface. Esc / backdrop /
// close dismiss.

const X_ICON = (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

const MODE_LABEL: Record<ResourceProfileDTO['mode'], string> = {
  auto: 'Auto',
  conserve: 'Conserve',
  balanced: 'Balanced',
  performance: 'Performance',
};

export interface ResourceDetailsDialogProps {
  profile: ResourceProfileDTO;
  /** L3 knob overrides — when both are present (and the profile carries
      `sources`+`bounds`) the Advanced section renders inside the dialog. */
  loadKnobPrefs?: () => Promise<ResourceKnobPrefs>;
  saveKnobPrefs?: (patch: Partial<Record<TunableKnobKey, number | null>>) => Promise<void>;
  onClose: () => void;
}

export default function ResourceDetailsDialog({
  profile,
  loadKnobPrefs,
  saveKnobPrefs,
  onClose,
}: ResourceDetailsDialogProps): JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null);
  const showKnobs = Boolean(profile.sources && profile.bounds && loadKnobPrefs && saveKnobPrefs);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    const t = setTimeout(() => closeRef.current?.focus(), 30);
    return () => {
      document.removeEventListener('keydown', onKey);
      clearTimeout(t);
    };
  }, [onClose]);

  return (
    <>
      <div className={styles.backdrop} role="presentation" onClick={onClose} />
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="How we sized this"
        data-testid="resource-details-dialog"
      >
        <div className={styles.head}>
          <div className={styles.headText}>
            <h3 className={styles.title}>How we sized this</h3>
            <p className={styles.sub}>
              The <b>{MODE_LABEL[profile.mode]}</b> profile, resolved against this gateway’s host.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className={styles.close}
            aria-label="Close"
            onClick={onClose}
          >
            {X_ICON}
          </button>
        </div>

        <div className={styles.body}>
          <ResourceCardDetails profile={profile} embedded />
          {showKnobs && loadKnobPrefs && saveKnobPrefs ? (
            <ResourceAdvancedKnobs
              profile={profile}
              loadKnobPrefs={loadKnobPrefs}
              saveKnobPrefs={saveKnobPrefs}
            />
          ) : null}
        </div>
      </div>
    </>
  );
}
