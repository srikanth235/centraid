import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { cx } from '../ui/cx.js';
import styles from './GatewayScreen.module.css';
import buttonCss from '../ui/Button.module.css';
import controlsCss from '../styles/controls.module.css';

// Owner Resource mode control (#521). Writes `gateway.resourceMode` through
// the device prefs store; the gateway reads it at serve boot and reports the
// active mode on the hardware-profile health component + metrics.

export type ResourceMode = 'auto' | 'conserve' | 'balanced' | 'performance';

export const RESOURCE_MODE_PREF_KEY = 'gateway.resourceMode';

const MODES: readonly {
  id: ResourceMode;
  label: string;
  blurb: string;
}[] = [
  {
    id: 'auto',
    label: 'Auto',
    blurb: 'Detect from cores, memory, and storage speed',
  },
  {
    id: 'conserve',
    label: 'Conserve',
    blurb: 'Fewer workers and lighter background work',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    blurb: 'Standard throughput for a dedicated host',
  },
  {
    id: 'performance',
    label: 'Performance',
    blurb: 'Higher concurrency when the machine is yours',
  },
];

export interface ResourceModeCardProps {
  loadMode: () => Promise<ResourceMode>;
  saveMode: (mode: ResourceMode) => Promise<void>;
  /** Resolved class from the last health poll, when known. */
  resolvedClass?: string;
  /** Active mode reported by health metrics (boot-applied). */
  activeMode?: string;
}

export function parseResourceModePref(prefs: Record<string, unknown>): ResourceMode {
  const raw = prefs[RESOURCE_MODE_PREF_KEY];
  if (raw === 'auto' || raw === 'conserve' || raw === 'balanced' || raw === 'performance') {
    return raw;
  }
  return 'auto';
}

export default function ResourceModeCard({
  loadMode,
  saveMode,
  resolvedClass,
  activeMode,
}: ResourceModeCardProps): JSX.Element {
  const [mode, setMode] = useState<ResourceMode>('auto');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  // Sync guard for in-flight loadMode resolves: a late GET must not clobber
  // an optimistic selection or mid-save mode (Gateway Overview re-renders
  // every second for uptime counters).
  const busyRef = useRef(false);

  const refresh = useCallback((): void => {
    void loadMode()
      .then((m) => {
        if (busyRef.current) return;
        setMode(m);
        setError(null);
      })
      .catch((err: unknown) => {
        if (busyRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [loadMode]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const select = async (next: ResourceMode): Promise<void> => {
    if (next === mode || busy) return;
    const prev = mode;
    setMode(next);
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setSavedNote(null);
    try {
      await saveMode(next);
      setSavedNote('Saved. Applies fully on the next gateway restart.');
    } catch (err) {
      setMode(prev);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const applied =
    activeMode && activeMode !== mode
      ? `Running as ${activeMode}${resolvedClass ? ` · ${resolvedClass}` : ''} until restart`
      : resolvedClass
        ? `Active profile: ${resolvedClass}`
        : null;

  return (
    <section className={styles.panel} data-testid="resource-mode-card">
      <div className={styles.panelHead}>
        <h2>Resource mode</h2>
        <span className={styles.panelMeta}>respect this machine</span>
      </div>
      <p className={styles.resourceLead}>
        Choose how hard the gateway may work in the background. Foreground chat and apps always stay
        first in line.
      </p>
      <div className={styles.resourceModes} role="radiogroup" aria-label="Resource mode">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={mode === m.id}
            disabled={busy}
            className={cx(
              buttonCss.btn,
              buttonCss.sm,
              mode === m.id ? controlsCss.soft : undefined,
              styles.resourceModeBtn,
              mode === m.id && styles.resourceModeBtnActive,
            )}
            onClick={() => void select(m.id)}
          >
            <span className={styles.resourceModeLabel}>{m.label}</span>
            <span className={styles.resourceModeBlurb}>{m.blurb}</span>
          </button>
        ))}
      </div>
      {applied ? <div className={styles.resourceNote}>{applied}</div> : null}
      {savedNote ? <div className={styles.resourceNote}>{savedNote}</div> : null}
      {error ? <div className={styles.resourceError}>Couldn’t save: {error}</div> : null}
    </section>
  );
}
