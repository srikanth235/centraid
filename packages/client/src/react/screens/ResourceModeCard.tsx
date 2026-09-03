import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { cx } from "../ui/cx.js";
import PowerPostureNote from "./PowerPostureNote.js";
import { presetHint } from "./resource-presets.js";
import {
  formatBudgetSummary,
  formatPauseUntil,
  msUntilTonight,
  PAUSE_ONE_HOUR_MS,
} from "./resource-summary.js";
import type {
  BackgroundPauseDTO,
  PowerContextState,
  ResourceKnobPrefs,
  ResourceMode,
  ResourceProfileDTO,
  TunableKnobKey,
} from "./resource-summary.js";
import ResourceCompareDialog from "./ResourceCompareDialog.js";
import ResourceDetailsDialog from "./ResourceDetailsDialog.js";

import a11y from "../styles/a11y.module.css";
import buttonCss from "../ui/Button.module.css";
import styles from "./GatewayScreen.module.css";

export type { ResourceMode } from "./resource-summary.js";

export const RESOURCE_MODE_PREF_KEY = "gateway.resourceMode";

const MODES: readonly { id: ResourceMode; label: string; blurb: string }[] = [
  {
    id: "auto",
    label: "Auto",
    blurb: "Detect from cores, memory, and storage speed",
  },
  {
    id: "conserve",
    label: "Conserve",
    blurb: "Fewer workers and lighter background work",
  },
  {
    id: "balanced",
    label: "Balanced",
    blurb: "Standard throughput for a dedicated host",
  },
  {
    id: "performance",
    label: "Performance",
    blurb: "Higher concurrency when the machine is yours",
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
  resolvedClass?: string;
  activeMode?: string;
  resourceProfile?: ResourceProfileDTO;
  backgroundPause?: BackgroundPauseDTO;
  powerContext?: PowerContextState;
  onPause?: (
    durationMs?: number
  ) => Promise<{ paused: boolean; until: string | null }>;
  onResume?: () => Promise<{ paused: boolean }>;
  loadKnobPrefs?: () => Promise<ResourceKnobPrefs>;
  saveKnobPrefs?: (
    patch: Partial<Record<TunableKnobKey, number | null>>
  ) => Promise<void>;
}

export function parseResourceModePref(
  prefs: Record<string, unknown>
): ResourceMode {
  const raw = prefs[RESOURCE_MODE_PREF_KEY];
  if (
    raw === "auto" ||
    raw === "conserve" ||
    raw === "balanced" ||
    raw === "performance"
  ) {
    return raw;
  }
  return "auto";
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
  const [mode, setMode] = useState<ResourceMode>("auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const busyRef = useRef(false);

  const [pauseState, setPauseState] = useState<BackgroundPauseDTO | null>(
    backgroundPause ?? null
  );
  const [pauseBusy, setPauseBusy] = useState(false);
  const [showPauseChoices, setShowPauseChoices] = useState(false);
  const pauseBusyRef = useRef(false);
  const pauseControlOn = Boolean(backgroundPause && onPause && onResume);

  const [seenBackgroundPause, setSeenBackgroundPause] =
    useState(backgroundPause);
  if (seenBackgroundPause !== backgroundPause) {
    setSeenBackgroundPause(backgroundPause);
    if (!pauseBusy && backgroundPause) setPauseState(backgroundPause);
  }

  const applyPause = async (durationMs?: number): Promise<void> => {
    if (!onPause || pauseBusy) return;
    setShowPauseChoices(false);
    pauseBusyRef.current = true;
    setPauseBusy(true);
    setError(null);
    try {
      const res = await onPause(durationMs);
      setPauseState({ paused: res.paused, until: res.until });
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : String(caughtError)
      );
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
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : String(caughtError)
      );
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
      .catch((caughtError: unknown) => {
        if (busyRef.current) return;
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : String(caughtError)
        );
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
      setSavedNote("Saved — applies fully on the next gateway restart.");
    } catch (caughtError) {
      setMode(prev);
      setError(
        caughtError instanceof Error ? caughtError.message : String(caughtError)
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const applied =
    activeMode && activeMode !== mode
      ? `Running as ${activeMode}${resolvedClass ? ` · ${resolvedClass}` : ""} until restart`
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
        Choose how hard the gateway may work in the background — foreground chat
        and apps always come first.
      </p>

      <div
        className={styles.resourceModes}
        role="radiogroup"
        aria-label="Resource mode"
      >
        {MODES.map((m) => (
          <label
            key={m.id}
            title={m.blurb}
            className={cx(
              styles.resourceModeBtn,
              mode === m.id && styles.resourceModeBtnActive
            )}
          >
            <input
              type="radio"
              className={a11y.srControl}
              name="resource-mode"
              checked={mode === m.id}
              disabled={busy}
              onChange={() => void select(m.id)}
            />
            <span className={styles.resourceModeLabel}>{m.label}</span>
            <span className={styles.resourceModeHint}>{presetHint(m.id)}</span>
          </label>
        ))}
      </div>

      {/* What the selected mode grants — the consequence, framed directly under
          the choice. Running/saved status folds in here, not as loose lines. */}
      {resourceProfile ? (
        <div className={styles.resourceSummary} data-testid="resource-summary">
          <div className={styles.resourceSummaryLine}>
            {formatBudgetSummary(resourceProfile)}
          </div>
          <div className={styles.resourceSummaryAttr}>
            Sized for this gateway’s host
          </div>
          {applied ? (
            <div className={styles.resourceSummaryStatus}>{applied}</div>
          ) : null}
          {savedNote ? (
            <div
              className={cx(
                styles.resourceSummaryStatus,
                styles.resourceSummaryStatusSaved
              )}
            >
              {savedNote}
            </div>
          ) : null}
        </div>
      ) : (
        <>
          {applied ? (
            <div className={styles.resourceNote}>{applied}</div>
          ) : null}
          {savedNote ? (
            <div className={styles.resourceNote}>{savedNote}</div>
          ) : null}
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
            <div
              className={styles.resourcePauseActive}
              data-testid="resource-pause-active"
            >
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
            <fieldset
              className={styles.resourcePauseChoices}
              aria-label="Pause duration"
            >
              <span className={styles.resourcePauseChoicesLabel}>
                Pause for
              </span>
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
            </fieldset>
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

      {error ? (
        <div className={styles.resourceError}>Couldn’t save: {error}</div>
      ) : null}

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
