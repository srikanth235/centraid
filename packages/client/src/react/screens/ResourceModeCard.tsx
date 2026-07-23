import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { cx } from '../ui/cx.js';
import styles from './GatewayScreen.module.css';
import buttonCss from '../ui/Button.module.css';
import controlsCss from '../styles/controls.module.css';
import ResourceCardDetails from './ResourceCardDetails.js';
import ResourceAdvancedKnobs from './ResourceAdvancedKnobs.js';
import PowerPostureNote from './PowerPostureNote.js';
import {
  formatBudgetSummary,
  formatPauseUntil,
  msUntilTonight,
  PAUSE_ONE_HOUR_MS,
  type BackgroundPauseDTO,
  type PowerContextState,
  type ResourceKnobPrefs,
  type ResourceProfileDTO,
  type TunableKnobKey,
} from './resource-summary.js';

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
  /**
   * Structured resource profile from `health.metrics.resourceProfile` (issue
   * #528). Present on modern gateways only — when absent the card renders
   * exactly as it did before (mode chips + running-vs-desired note), no
   * L1 budget summary and no L2 disclosure.
   */
  resourceProfile?: ResourceProfileDTO;
  /**
   * Background-work pause state from `health.metrics.backgroundPause` (issue
   * #528). Absent → the pause control is hidden entirely (older gateway).
   * When present the card reconciles its optimistic pause state against this
   * on every poll.
   */
  backgroundPause?: BackgroundPauseDTO;
  /**
   * Power-context posture from `health.metrics.powerContext` (issue #528 Phase
   * D). Present on modern gateways only. Drives a compact posture note about
   * the gateway HOST — battery/thermal chrome only when the host has a battery,
   * a shared-server CPU-steal fact otherwise. Absent → no posture note.
   */
  powerContext?: PowerContextState;
  /** Hot-apply a background-work pause; absent ⇒ no pause control. */
  onPause?: (durationMs?: number) => Promise<{ paused: boolean; until: string | null }>;
  /** Lift a background-work pause; absent ⇒ no pause control. */
  onResume?: () => Promise<{ paused: boolean }>;
  /**
   * Load saved knob overrides for the L3 "Tune" rung (issue #528 Phase F).
   * Absent (or a profile without `sources`/`bounds`) hides the Advanced
   * section entirely.
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
  // Sync guard for in-flight loadMode resolves: a late GET must not clobber
  // an optimistic selection or mid-save mode (Gateway Overview re-renders
  // every second for uptime counters).
  const busyRef = useRef(false);

  // ── Pause background work (L0, issue #528) ──
  // Optimistic pause state seeded from health, reconciled on each poll unless
  // a POST/DELETE is in flight (same busyRef discipline as the mode save).
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
      {pauseControlOn ? (
        <div className={styles.resourcePause} data-testid="resource-pause">
          {pauseState?.paused ? (
            <div className={styles.resourcePauseActive} data-testid="resource-pause-active">
              <span className={styles.resourcePauseLabel}>
                {formatPauseUntil(pauseState.until)}
              </span>
              <button
                type="button"
                className={cx(buttonCss.btn, buttonCss.sm)}
                disabled={pauseBusy}
                onClick={() => void liftPause()}
              >
                Resume
              </button>
            </div>
          ) : showPauseChoices ? (
            <div className={styles.resourcePauseChoices} role="group" aria-label="Pause duration">
              <button
                type="button"
                className={cx(buttonCss.btn, buttonCss.sm)}
                disabled={pauseBusy}
                onClick={() => void applyPause(PAUSE_ONE_HOUR_MS)}
              >
                1 hour
              </button>
              <button
                type="button"
                className={cx(buttonCss.btn, buttonCss.sm)}
                disabled={pauseBusy}
                onClick={() => void applyPause(msUntilTonight(Date.now()))}
              >
                Until tonight
              </button>
              <button
                type="button"
                className={cx(buttonCss.btn, buttonCss.sm)}
                disabled={pauseBusy}
                onClick={() => void applyPause(undefined)}
              >
                Until I resume
              </button>
            </div>
          ) : (
            <button
              type="button"
              className={cx(buttonCss.btn, buttonCss.sm, styles.resourcePauseOpen)}
              data-testid="resource-pause-open"
              onClick={() => setShowPauseChoices(true)}
            >
              Pause background work
            </button>
          )}
        </div>
      ) : null}
      {resourceProfile ? (
        <div className={styles.resourceSummary} data-testid="resource-summary">
          <div className={styles.resourceSummaryLine}>{formatBudgetSummary(resourceProfile)}</div>
          <div className={styles.resourceSummaryAttr}>Sized for this gateway’s host</div>
        </div>
      ) : null}
      {powerContext ? <PowerPostureNote power={powerContext} /> : null}
      {applied ? <div className={styles.resourceNote}>{applied}</div> : null}
      {savedNote ? <div className={styles.resourceNote}>{savedNote}</div> : null}
      {error ? <div className={styles.resourceError}>Couldn’t save: {error}</div> : null}
      {resourceProfile ? <ResourceCardDetails profile={resourceProfile} /> : null}
      {resourceProfile?.sources && resourceProfile.bounds && loadKnobPrefs && saveKnobPrefs ? (
        <ResourceAdvancedKnobs
          profile={resourceProfile}
          loadKnobPrefs={loadKnobPrefs}
          saveKnobPrefs={saveKnobPrefs}
        />
      ) : null}
    </section>
  );
}
