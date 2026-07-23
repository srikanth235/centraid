import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { cx } from '../ui/cx.js';
import styles from './GatewayScreen.module.css';
import buttonCss from '../ui/Button.module.css';
import {
  knobPending,
  knobRowsFromProfile,
  knobSoftWarnings,
  validateKnobDraft,
  type KnobRowFacts,
  type ResourceKnobPrefs,
  type ResourceProfileDTO,
  type TunableKnobKey,
} from './resource-summary.js';

// L3 "Tune" rung of the Resource card (issue #528 Phase F): advanced knobs the
// owner can override. Collapsed by default (an aria-expanded button + region,
// not native <details>, so it stays deterministic under jsdom — mirrors
// ResourceCardDetails). Each knob is Linked to the derived budget by default,
// Custom once overridden, or locked when an operator env var set it. Overrides
// are plain prefs writes; they apply on the next gateway restart, like the mode.

export interface ResourceAdvancedKnobsProps {
  /** Must carry `sources` + `bounds`; the caller gates on that, we re-check. */
  profile: ResourceProfileDTO;
  loadKnobPrefs: () => Promise<ResourceKnobPrefs>;
  saveKnobPrefs: (patch: Partial<Record<TunableKnobKey, number | null>>) => Promise<void>;
}

const EMPTY_DRAFTS: Record<TunableKnobKey, string> = {
  workerMaxConcurrent: '',
  workerMaxOldGenerationMb: '',
  workerPoolSize: '',
  replicationConcurrency: '',
};

export default function ResourceAdvancedKnobs({
  profile,
  loadKnobPrefs,
  saveKnobPrefs,
}: ResourceAdvancedKnobsProps): JSX.Element | null {
  const rows = knobRowsFromProfile(profile);
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<ResourceKnobPrefs | null>(null);
  const [drafts, setDrafts] = useState<Record<TunableKnobKey, string>>(EMPTY_DRAFTS);
  const [busyKey, setBusyKey] = useState<TunableKnobKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState(false);
  // A save in flight must not be clobbered by a late load resolve.
  const busyRef = useRef(false);

  const load = useCallback((): void => {
    void loadKnobPrefs()
      .then((prefs) => {
        if (busyRef.current) return;
        setSaved(prefs);
        setDrafts({
          workerMaxConcurrent: prefs.workerMaxConcurrent?.toString() ?? '',
          workerMaxOldGenerationMb: prefs.workerMaxOldGenerationMb?.toString() ?? '',
          workerPoolSize: prefs.workerPoolSize?.toString() ?? '',
          replicationConcurrency: prefs.replicationConcurrency?.toString() ?? '',
        });
        setError(null);
      })
      .catch((err: unknown) => {
        if (busyRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [loadKnobPrefs]);

  useEffect(() => {
    load();
  }, [load]);

  if (!rows) return null;

  const desiredOf = (key: TunableKnobKey): number | null => saved?.[key] ?? null;
  const effectiveOf = (facts: KnobRowFacts): number => {
    const draft = drafts[facts.key].trim();
    if (draft !== '') {
      const parsed = validateKnobDraft(draft, facts.bounds);
      if (parsed.ok) return parsed.value;
    }
    return desiredOf(facts.key) ?? facts.running;
  };

  const byKey = new Map(rows.map((r) => [r.key, r]));
  const concurrentRow = byKey.get('workerMaxConcurrent');
  const memRow = byKey.get('workerMaxOldGenerationMb');
  const warnings =
    concurrentRow && memRow
      ? knobSoftWarnings({
          effectiveConcurrent: effectiveOf(concurrentRow),
          effectiveMemMb: effectiveOf(memRow),
          hostCores: profile.host.cores,
          hostMemoryBytes: profile.host.totalMemoryBytes,
        })
      : { concurrencyOverCores: false, memoryOverHalf: false };

  const handleDraftChange = (key: TunableKnobKey, value: string): void => {
    setSavedNote(false);
    setDrafts((d) => ({ ...d, [key]: value }));
  };

  const runWrite = async (
    key: TunableKnobKey,
    patchValue: number | null,
    nextSavedValue: number | null,
    nextDraft: string,
  ): Promise<void> => {
    busyRef.current = true;
    setBusyKey(key);
    setError(null);
    try {
      await saveKnobPrefs({ [key]: patchValue });
      setSaved((prev) => ({
        ...(prev ?? {
          workerMaxConcurrent: null,
          workerMaxOldGenerationMb: null,
          workerPoolSize: null,
          replicationConcurrency: null,
        }),
        [key]: nextSavedValue,
      }));
      setDrafts((d) => ({ ...d, [key]: nextDraft }));
      setSavedNote(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      busyRef.current = false;
      setBusyKey(null);
    }
  };

  const handleSave = (facts: KnobRowFacts, value: number): void => {
    void runWrite(facts.key, value, value, value.toString());
  };
  const handleClear = (facts: KnobRowFacts): void => {
    void runWrite(facts.key, null, null, '');
  };

  return (
    <div className={styles.resourceAdvanced}>
      <button
        type="button"
        className={styles.resourceDetailsToggle}
        aria-expanded={open}
        data-testid="resource-advanced-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <span>Advanced</span>
        <span className={styles.resourceDetailsChevron} aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open ? (
        <div className={styles.resourceAdvancedBody} data-testid="resource-advanced-body">
          <p className={styles.resourceAdvancedLead}>
            Linked to the sized budget by default. Override a knob to go Custom; changes apply on
            the next gateway restart.
          </p>
          {rows.map((facts) => {
            const key = facts.key;
            const locked = facts.source === 'env';
            const desired = desiredOf(key);
            const draft = drafts[key];
            const trimmed = draft.trim();
            const parsed = trimmed === '' ? null : validateKnobDraft(trimmed, facts.bounds);
            const hardError = parsed && !parsed.ok ? parsed.error : null;
            const isCustom = !locked && desired !== null;
            const pending = knobPending(facts.running, desired, facts.source);
            const canSave =
              !locked &&
              busyKey === null &&
              parsed !== null &&
              parsed.ok &&
              parsed.value !== desired;
            const rowWarn =
              key === 'workerMaxConcurrent'
                ? warnings.concurrencyOverCores
                : key === 'workerMaxOldGenerationMb'
                  ? warnings.memoryOverHalf
                  : false;
            return (
              <div className={styles.resourceKnobRow} key={key} data-testid={`knob-${key}`}>
                <div className={styles.resourceKnobHead}>
                  <span className={styles.resourceKnobLabel}>{facts.label}</span>
                  {locked ? (
                    <span className={styles.resourceKnobLock} data-testid={`knob-${key}-lock`}>
                      <span aria-hidden="true">🔒</span> {facts.envVar}
                    </span>
                  ) : isCustom ? (
                    <span className={styles.resourceKnobTagCustom}>Custom</span>
                  ) : (
                    <span className={styles.resourceKnobTagLinked}>Linked</span>
                  )}
                </div>
                <div className={styles.resourceKnobControls}>
                  <input
                    type="number"
                    inputMode="numeric"
                    className={styles.resourceKnobInput}
                    aria-label={facts.label}
                    disabled={locked || busyKey === key}
                    value={locked ? facts.running.toString() : draft}
                    placeholder={facts.running.toString()}
                    min={facts.bounds.min}
                    max={facts.bounds.max}
                    onChange={(e) => handleDraftChange(key, e.target.value)}
                  />
                  {locked ? null : (
                    <>
                      <button
                        type="button"
                        className={cx(buttonCss.btn, buttonCss.sm, buttonCss.soft)}
                        disabled={!canSave}
                        onClick={() => parsed?.ok && handleSave(facts, parsed.value)}
                      >
                        Save
                      </button>
                      {isCustom ? (
                        <button
                          type="button"
                          className={cx(buttonCss.btn, buttonCss.sm, buttonCss.ghost)}
                          disabled={busyKey === key}
                          onClick={() => handleClear(facts)}
                        >
                          Reset to Linked
                        </button>
                      ) : null}
                    </>
                  )}
                </div>
                <div className={styles.resourceKnobMeta}>Running {facts.running}</div>
                {locked ? (
                  <div className={styles.resourceKnobHelp}>
                    Set by the operator ({facts.envVar}) — remove the variable to tune here.
                  </div>
                ) : null}
                {hardError ? (
                  <div className={styles.resourceKnobError} data-testid={`knob-${key}-error`}>
                    {hardError}
                  </div>
                ) : null}
                {!hardError && rowWarn ? (
                  <div className={styles.resourceKnobWarn} data-testid={`knob-${key}-warn`}>
                    {key === 'workerMaxConcurrent'
                      ? `More workers than this host’s ${profile.host.cores} cores — may contend.`
                      : 'Workers × memory would exceed half of host memory.'}
                  </div>
                ) : null}
                {pending ? (
                  <div className={styles.resourceKnobPending}>
                    Applies on the next gateway restart.
                  </div>
                ) : null}
              </div>
            );
          })}
          {savedNote ? (
            <div className={styles.resourceNote} data-testid="resource-advanced-saved">
              Saved. Applies on the next gateway restart.
            </div>
          ) : null}
          {error ? <div className={styles.resourceError}>Couldn’t save: {error}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
