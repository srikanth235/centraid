import { useEffect, useRef, useState, type JSX } from 'react';
import { cx } from '../ui/cx.js';
import buttonCss from '../ui/Button.module.css';
import styles from './ResourceDialogs.module.css';
import {
  PRESET_MODES,
  presetHint,
  resourceCompareRows,
  type PresetMode,
} from './resource-presets.js';
import type { ResourceMode } from './resource-summary.js';

// Compare dialog (issue #528 follow-up): every resource mode side by side so the
// owner sees the consequence BEFORE committing — the gap the inline card left,
// which only ever showed the already-active mode's numbers. Read from the
// static preset mirror (resource-presets.ts); selecting + Apply routes back
// through the card's saveMode. Esc / backdrop / Cancel dismiss.

const MODE_COLUMNS: readonly ResourceMode[] = ['auto', ...PRESET_MODES];
const MODE_LABEL: Record<ResourceMode, string> = {
  auto: 'Auto',
  conserve: 'Conserve',
  balanced: 'Balanced',
  performance: 'Performance',
};

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

export interface ResourceCompareDialogProps {
  /** The mode currently saved on the card — the initial selection. */
  current: ResourceMode;
  /** Persist the chosen mode (the card's saveMode path), then close. */
  onApply: (mode: ResourceMode) => void;
  onClose: () => void;
}

export default function ResourceCompareDialog({
  current,
  onApply,
  onClose,
}: ResourceCompareDialogProps): JSX.Element {
  const [sel, setSel] = useState<ResourceMode>(current);
  const closeRef = useRef<HTMLButtonElement>(null);
  const rows = resourceCompareRows();

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

  const cellValue = (mode: ResourceMode, values: Record<PresetMode, string>): string =>
    mode === 'auto' ? '—' : values[mode];

  return (
    <>
      <div className={styles.backdrop} role="presentation" onClick={onClose} />
      <div
        className={cx(styles.dialog, styles.dialogWide)}
        role="dialog"
        aria-modal="true"
        aria-label="Compare resource modes"
        data-testid="resource-compare-dialog"
      >
        <div className={styles.head}>
          <div className={styles.headText}>
            <h3 className={styles.title}>Compare resource modes</h3>
            <p className={styles.sub}>
              What each mode grants the gateway’s background work. Foreground chat and apps always
              come first.
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
          <div className={styles.cmp} role="radiogroup" aria-label="Resource mode">
            <div className={styles.cmpHeadCell} />
            {MODE_COLUMNS.map((mode) => (
              <div key={mode} className={styles.cmpHeadCell}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={sel === mode}
                  className={cx(styles.cmpMode, sel === mode && styles.cmpModeActive)}
                  onClick={() => setSel(mode)}
                  data-testid={`resource-compare-mode-${mode}`}
                >
                  <span className={styles.cmpName}>{MODE_LABEL[mode]}</span>
                  <span className={styles.cmpPick}>{presetHint(mode)}</span>
                </button>
              </div>
            ))}

            {rows.map((row) => (
              <div key={row.key} style={{ display: 'contents' }}>
                <div className={styles.cmpRowLabel}>
                  {row.label}
                  <span className={styles.cmpQ} title={row.hint} aria-label={row.hint}>
                    ⓘ
                  </span>
                </div>
                {MODE_COLUMNS.map((mode) => {
                  const val = cellValue(mode, row.values);
                  const hot = mode === sel && val !== '—';
                  return (
                    <div
                      key={mode}
                      className={cx(
                        styles.cmpCell,
                        hot && styles.cmpCellHot,
                        mode === sel && styles.cmpColActive,
                      )}
                    >
                      {val}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          <p className={styles.cmpNote}>
            <b>Auto</b> measures this machine — cores, memory, storage speed, and CPU competition —
            then applies <b>Conserve</b> on a constrained or shared host, or <b>Balanced</b> on a
            dedicated one. It never chooses Performance for you.
          </p>
        </div>

        <div className={styles.foot}>
          <div className={styles.footMsg}>
            Selected: <b>{MODE_LABEL[sel]}</b>
          </div>
          <div className={styles.footActions}>
            <button
              type="button"
              className={cx(buttonCss.btn, buttonCss.sm, buttonCss.ghost)}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="button"
              className={cx(buttonCss.btn, buttonCss.sm, buttonCss.primary)}
              onClick={() => onApply(sel)}
              data-testid="resource-compare-apply"
            >
              Use this mode
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
