import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { cx } from '../ui/cx.js';
import styles from './GatewayScreen.module.css';
import buttonCss from '../ui/Button.module.css';
import ResourceCompareDialog from './ResourceCompareDialog.js';
import ResourceDetailsDialog from './ResourceDetailsDialog.js';
import PowerPostureNote from './PowerPostureNote.js';
import { presetHint } from './resource-presets.js';
import {
  formatBudgetSummary,
  formatPauseUntil,
  msUntilTonight,
  PAUSE_ONE_HOUR_MS,
  type BackgroundPauseDTO,
  type PowerContextState,
  type ResourceKnobPrefs,
  type ResourceMode,
  type ResourceProfileDTO,
  type TunableKnobKey,
} from './resource-summary.js';

// Owner Resource mode control (#521). Writes `gateway.resourceMode` through the
// device prefs store; the gateway reads it at serve boot and reports the active
// mode on the hardware-profile health component + metrics. The card is a
// compact choose-and-glance surface: pick a mode, read the one-line budget, and
// open a dialog to Compare all modes or see How we sized this (issue #528
// follow-up) — the dense tables no longer stack in the card body.

export type { ResourceMode } from './resource-summary.js';

export const RESOURCE_MODE_PREF_KEY = 'gateway.resourceMode';

const MODES: readonly { id: ResourceMode; label: string; blurb: string }[] = [
  { id: 'auto', label: 'Auto', blurb: 'Detect from cores, memory, and storage speed' },
  { id: 'conserve', label: 'Conserve', blurb: 'Fewer workers and lighter background work' },
  { id: 'balanced', label: 'Balanced', blurb: 'Standard throughput for a dedicated host' },
  {
    id: 'performance',
    label: 'Performance',
    blurb: 'Higher concurrency when the machine is yours',
  },
];

const COMPARE_ICON = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M9 3v18M15 3v18M3 9h18M3 15h18" />
  </svg>
);
const SIZING_ICON = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M3 3v18h18" />
    <path d="M7 15l3-4 3 2 4-6" />
  </svg>
);
const PAUSE_ICON = (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="6" y="5" width="4" height="14" rx="1.5" />
    <rect x="14" y="5" width="4" height="14" rx="1.5" />
  </svg>
);

export interface ResourceModeCardProps {
  loadMode: () => Promise<ResourceMode>;
  saveMode: (mode: ResourceMode) => Promise<void>;
  /** Resolved class from the last health poll, when known. */
  resolvedClass?: string;
  /** Active mode reported by health metrics (boot-applied). */
  activeMode?: string;
  /**
   * Structured resource profile from `health.metrics.resourceProfile` (issue
   * #528). Present on modern gateways only — when absent the card renders the
   * mode picker + running-vs-desired note, but no L1 budget summary and no
   * "How we sized this" dialog opener.
   */
  resourceProfile?: ResourceProfileDTO;
  /**
   * Background-work pause state from `health.metrics.backgroundPause` (issue
   * #528). Absent → the pause control is hidden entirely (older gateway).
   */
  backgroundPause?: BackgroundPauseDTO;
  /**
   * Power-context posture from `health.metrics.powerContext` (issue #528 Phase
   * D). Present on modern gateways only.
   */
  powerContext?: PowerContextState;
  /** Hot-apply a background-work pause; absent ⇒ no pause control. */
  onPause?: (durationMs?: number) => Promise<{ paused: boolean; until: string | null }>;
  /** Lift a background-work pause; absent ⇒ no pause control. */
  onResume?: () => Promise<{ paused: boolean }>;
  /**
   * Load saved knob overrides for the L3 "Tune" rung (issue #528 Phase F),
   * shown inside the "How we sized this" dialog. Absent (or a profile without
   * `sources`/`bounds`) hides the Advanced section.
   */
  loadKnobPrefs?: () => Promise<ResourceKnobPrefs>;
  /** Persist a knob override; `null` clears it back to Linked. */
  saveKnobPrefs?: (patch: Partial<Record<TunableKnobKey, number | null>>) => Promise<void>;
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
  resourceProfile,
  backgroundPause,
  powerContext,
  onPause,
  onResume,
  loadKnobPrefs,
  saveKnobPrefs,
}: ResourceModeCardProps): JSX.Element {
  const [mode, setMode] = useState<ResourceMode>('auto');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Sync guard for in-flight loadMode resolves: a late GET must not clobber an
  // optimistic selection or mid-save mode (Gateway Overview re-renders every
  // second for uptime counters).
  const busyRef = useRef(false);

  // ── Pause background work (L0, issue #528) ──
  const [pauseState, setPauseState] = useState<BackgroundPauseDTO | null>(backgroundPause ?? null);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [showPauseChoices, setShowPauseChoices] = useState(false);
  const pauseBusyRef = useRef(false);
  const pauseControlOn = Boolean(backgroundPause && onPause && onResume);

  useEffect(() => {
    if (pauseBusyRef.current) return;
    if (backgroundPause) setPauseState(backgroundPause);
  }, [backgroundPause]);

  const applyPause = async (durationMs?: number): Promise<void> => {
    if (!onPause || pauseBusy) return;
    setShowPauseChoices(false);
    pauseBusyRef.current = true;
    setPauseBusy(true);
    setError(null);
    try {
      const res = await onPause(durationMs);
      setPauseState({ paused: res.paused, until: res.until });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      pauseBusyRef.current = false;
      setPauseBusy(false);
    }
  };

  const liftPause = async (): Promise<void> => {
    if (!onResume || pauseBusy) return;
    pauseBusyRef.current = true;
    setPauseBusy(true);
    setError(null);
    try {
      const res = await onResume();
      setPauseState({ paused: res.paused, until: null });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      pauseBusyRef.current = false;
      setPauseBusy(false);
    }
  };

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
            title={m.blurb}
            className={cx(styles.resourceModeBtn, mode === m.id && styles.resourceModeBtnActive)}
            onClick={() => void select(m.id)}
          >
            <span className={styles.resourceModeLabel}>{m.label}</span>
            <span className={styles.resourceModeHint}>{presetHint(m.id)}</span>
          </button>
        ))}
      </div>

      {/* What the selected mode grants — the consequence, framed directly under
          the choice. Running/saved status folds in here, not as loose lines. */}
      {resourceProfile ? (
        <div className={styles.resourceSummary} data-testid="resource-summary">
          <div className={styles.resourceSummaryLine}>{formatBudgetSummary(resourceProfile)}</div>
          <div className={styles.resourceSummaryAttr}>Sized for this gateway’s host</div>
          {applied ? <div className={styles.resourceSummaryStatus}>{applied}</div> : null}
          {savedNote ? (
            <div className={cx(styles.resourceSummaryStatus, styles.resourceSummaryStatusSaved)}>
              {savedNote}
            </div>
          ) : null}
        </div>
      ) : (
        <>
          {applied ? <div className={styles.resourceNote}>{applied}</div> : null}
          {savedNote ? <div className={styles.resourceNote}>{savedNote}</div> : null}
        </>
      )}

      <div className={styles.resourceActions}>
        <button
          type="button"
          className={styles.resourceAction}
          data-testid="resource-compare-open"
          onClick={() => setCompareOpen(true)}
        >
          <span className={styles.resourceActionIcon}>{COMPARE_ICON}</span>
          Compare all modes
        </button>
        {resourceProfile ? (
          <button
            type="button"
            className={styles.resourceAction}
            data-testid="resource-details-open"
            onClick={() => setDetailsOpen(true)}
          >
            <span className={styles.resourceActionIcon}>{SIZING_ICON}</span>
            How we sized this
          </button>
        ) : null}
      </div>

      {powerContext ? <PowerPostureNote power={powerContext} /> : null}

      {pauseControlOn ? (
        <div className={styles.resourcePause} data-testid="resource-pause">
          {pauseState?.paused ? (
            <div className={styles.resourcePauseActive} data-testid="resource-pause-active">
              <span className={styles.resourcePauseLabel}>
                {formatPauseUntil(pauseState.until)}
              </span>
              <button
                type="button"
                className={cx(buttonCss.btn, buttonCss.sm, buttonCss.soft)}
                disabled={pauseBusy}
                onClick={() => void liftPause()}
              >
                Resume
              </button>
            </div>
          ) : showPauseChoices ? (
            <div className={styles.resourcePauseChoices} role="group" aria-label="Pause duration">
              <span className={styles.resourcePauseChoicesLabel}>Pause for</span>
              <button
                type="button"
                className={cx(buttonCss.btn, buttonCss.sm, buttonCss.soft)}
                disabled={pauseBusy}
                onClick={() => void applyPause(PAUSE_ONE_HOUR_MS)}
              >
                1 hour
              </button>
              <button
                type="button"
                className={cx(buttonCss.btn, buttonCss.sm, buttonCss.soft)}
                disabled={pauseBusy}
                onClick={() => void applyPause(msUntilTonight(Date.now()))}
              >
                Until tonight
              </button>
              <button
                type="button"
                className={cx(buttonCss.btn, buttonCss.sm, buttonCss.soft)}
                disabled={pauseBusy}
                onClick={() => void applyPause(undefined)}
              >
                Until I resume
              </button>
            </div>
          ) : (
            <button
              type="button"
              className={styles.resourcePauseBtn}
              data-testid="resource-pause-open"
              disabled={pauseBusy}
              onClick={() => setShowPauseChoices(true)}
            >
              <span className={styles.resourcePauseIcon}>{PAUSE_ICON}</span>
              Pause background work
            </button>
          )}
        </div>
      ) : null}

      {error ? <div className={styles.resourceError}>Couldn’t save: {error}</div> : null}

      {compareOpen ? (
        <ResourceCompareDialog
          current={mode}
          onClose={() => setCompareOpen(false)}
          onApply={(next) => {
            setCompareOpen(false);
            void select(next);
          }}
        />
      ) : null}
      {detailsOpen && resourceProfile ? (
        <ResourceDetailsDialog
          profile={resourceProfile}
          loadKnobPrefs={loadKnobPrefs}
          saveKnobPrefs={saveKnobPrefs}
          onClose={() => setDetailsOpen(false)}
        />
      ) : null}
    </section>
  );
}
