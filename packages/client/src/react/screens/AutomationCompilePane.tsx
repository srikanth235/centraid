import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import type {
  CompileAttemptDTO,
  CompileStepDTO,
  TurnWatchOutcome,
} from "../screen-contracts.js";
import { cx } from "../ui/cx.js";
import { Icon } from "../ui/index.js";
import AutomationCompileArtifacts from "./AutomationCompileArtifacts.js";
import type { ArtifactFile } from "./AutomationCompileArtifacts.js";

import au from "../styles/automation.module.css";
import styles from "./AutomationCompilePane.module.css";

/*
 * The compiler readout — the right rail of the compile screen.
 *
 * This is the half of the automations UX that was missing. Compiling used to
 * be a fire-and-forget side effect of Save that threw you onto the run screen,
 * so a compile that FAILED had nowhere to be read. Here the loop closes in one
 * place: compile → watch the steps land → read the failure → edit the
 * instructions → recompile → test the plan for real.
 *
 * The rail READS; it does not author. There is exactly one editable surface on
 * this screen — the instructions field in the left column — so a failure here
 * hands you back there rather than opening a second way to change the same
 * thing. (An earlier revision put a chat composer in this rail. Two writers on
 * one field is how you end up not knowing which text is live.)
 *
 * Three bands, in the order the loop runs:
 *   1. Verdict   — what the plan is right now, the failure text, and the one
 *                  button that changes it.
 *   2. Steps     — the compiler's working, live, one row per step.
 *   3. Artifacts — the deterministic handler.js / automation.json it produced.
 */

export interface AutomationCompilePaneProps {
  /** Create mode has no automation to compile yet — the rail explains itself
   *  instead of offering dead buttons. */
  mode: "create" | "edit";
  /** Instructions differ from the last compiled baseline: the plan is stale. */
  dirty: boolean;
  /**
   * Bumped by the editor after a successful save to compile the freshly
   * persisted instructions. A nonce rather than a callback so the rail keeps
   * sole ownership of the compile loop — Save asks for a compile, it does not
   * perform one, and there is exactly one code path that starts a compile.
   */
  compileNonce: number;
  onCompile: () => Promise<string | null>;
  onTestRun: () => Promise<string | null>;
  /** Hand a failure back to the one editable surface: focus the instructions. */
  onEditInstructions: () => void;
  loadAttempts: () => Promise<CompileAttemptDTO[]>;
  loadTurnSteps: (turnId: string) => Promise<CompileStepDTO[]>;
  watchTurnSteps: (
    turnId: string,
    onSteps: (steps: CompileStepDTO[]) => void,
    signal: AbortSignal
  ) => Promise<TurnWatchOutcome>;
  onReadSource: () => Promise<{
    manifest: string | null;
    handler: string | null;
  }>;
  onOpenRun: (runId: string) => void;
  onOpenRuns: () => void;
}

type Phase = "idle" | "compiling" | "testing";
/** What the rail is currently watching — a compile attempt or a test run. The
 *  step list is shared; only the framing differs. */
type Watched = { turnId: string; kind: "compile" | "test" } | null;

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 60
    ? `${s.toFixed(s < 10 ? 1 : 0)}s`
    : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function StepRow({ step }: { step: CompileStepDTO }): JSX.Element {
  return (
    <li
      className={styles.step}
      data-status={step.status}
      data-testid="compile-step"
    >
      <span className={styles.stepMark} aria-hidden="true">
        <Icon
          name={
            step.status === "running"
              ? "Loader"
              : step.status === "ok"
                ? "Check"
                : "AlertTriangle"
          }
          size={11}
        />
      </span>
      <span className={styles.stepLabel}>{step.label}</span>
      {step.durationMs === null ? null : (
        <span className={styles.stepTime}>{fmtDuration(step.durationMs)}</span>
      )}
      {step.detail ? (
        <span className={styles.stepDetail}>{step.detail}</span>
      ) : null}
    </li>
  );
}

/**
 * A live "m:ss" for a turn that is still open, or null when nothing is running.
 *
 * The interval only exists while `startedAt` is a number, so a settled rail
 * holds no timer. Seconds resolution is deliberate: this answers "is it moving
 * or wedged?", and a faster tick would only re-render the rail more often.
 */
function useElapsedLabel(startedAt: number | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  // No re-read of the clock when a turn opens: `now` can only be older than a
  // freshly-started turn, and the elapsed seconds are floored at zero — so the
  // rail already reads "0:00" until the first tick lands.
  if (startedAt === null) return null;
  const secs = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

export default function AutomationCompilePane({
  mode,
  dirty,
  compileNonce,
  onCompile,
  onTestRun,
  onEditInstructions,
  loadAttempts,
  loadTurnSteps,
  watchTurnSteps,
  onReadSource,
  onOpenRun,
  onOpenRuns,
}: AutomationCompilePaneProps): JSX.Element {
  const [attempts, setAttempts] = useState<CompileAttemptDTO[]>([]);
  const [steps, setSteps] = useState<CompileStepDTO[]>([]);
  const [watched, setWatched] = useState<Watched>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [source, setSource] = useState<{
    manifest: string | null;
    handler: string | null;
  } | null>(null);
  const [file, setFile] = useState<ArtifactFile>("handler");
  const [showArtifacts, setShowArtifacts] = useState(false);
  const watchRef = useRef<AbortController | null>(null);

  const isCreate = mode === "create";
  const latest = attempts[0] ?? null;

  const refreshAttempts = useCallback(async () => {
    try {
      const next = await loadAttempts();
      setAttempts(next);
      return next;
    } catch {
      return [];
    }
  }, [loadAttempts]);

  const refreshSource = useCallback(
    (): Promise<void> =>
      onReadSource()
        .then(setSource)
        .catch(() => setSource({ handler: null, manifest: null })),
    [onReadSource]
  );

  /**
   * Follow one turn to settlement. `settled: false` means the stream dropped
   * with the turn still open, so we fall back to a cold read rather than
   * leaving the rail spinning — the same honesty rule the run thread follows,
   * minus its rejoin ladder (a compile is short, and the owner is watching).
   */
  const follow = useCallback(
    async (turnId: string, kind: "compile" | "test"): Promise<void> => {
      watchRef.current?.abort();
      const controller = new AbortController();
      watchRef.current = controller;
      setWatched({ kind, turnId });
      setSteps([]);
      try {
        const { settled } = await watchTurnSteps(
          turnId,
          setSteps,
          controller.signal
        );
        if (!settled && !controller.signal.aborted) {
          setSteps(await loadTurnSteps(turnId).catch(() => []));
        }
      } catch {
        setSteps(await loadTurnSteps(turnId).catch(() => []));
      } finally {
        if (watchRef.current === controller) watchRef.current = null;
      }
      if (controller.signal.aborted) return;
      await refreshAttempts();
      if (kind === "compile") await refreshSource();
    },
    [loadTurnSteps, refreshAttempts, refreshSource, watchTurnSteps]
  );

  // On mount (edit mode), show the last attempt cold. A compile still running
  // when the screen opens is joined live — otherwise reopening the compiler
  // mid-compile showed a finished-looking empty list.
  useEffect(() => {
    if (isCreate) return;
    let active = true;
    void (async () => {
      const next = await refreshAttempts();
      if (!active) return;
      const last = next[0];
      if (!last) return;
      if (last.status === "running") {
        void follow(last.turnId, "compile");
        return;
      }
      setWatched({ kind: "compile", turnId: last.turnId });
      setSteps(await loadTurnSteps(last.turnId).catch(() => []));
    })();
    return () => {
      active = false;
    };
  }, [follow, isCreate, loadTurnSteps, refreshAttempts]);

  useEffect(() => {
    if (!showArtifacts || source) return;
    void refreshSource();
  }, [refreshSource, showArtifacts, source]);

  useEffect(() => () => watchRef.current?.abort(), []);

  const doCompile = useCallback((): void => {
    setPhase("compiling");
    void onCompile()
      .then(async (turnId) => {
        if (turnId) await follow(turnId, "compile");
      })
      .finally(() => setPhase("idle"));
  }, [follow, onCompile]);

  // Save asks for a compile by bumping the nonce. Guarded on the seen value so
  // a re-render (or the initial mount, where the nonce starts at 0) never
  // fires a compile the owner didn't ask for.
  const seenNonce = useRef(compileNonce);
  useEffect(() => {
    if (compileNonce === seenNonce.current) return;
    seenNonce.current = compileNonce;
    doCompile();
  }, [compileNonce, doCompile]);

  const doTest = (): void => {
    setPhase("testing");
    void onTestRun()
      .then(async (turnId) => {
        if (turnId) await follow(turnId, "test");
      })
      .finally(() => setPhase("idle"));
  };

  // `phase` only knows about compiles THIS mount started. A compile that was
  // already running when the rail loaded (reload mid-compile, or the compile
  // the editor kicks off on create) shows up in `latest` instead — and a
  // coding-agent compile runs for minutes, so that window is wide. Keying
  // "busy" off `phase` alone left Compile clickable during one, which starts a
  // second concurrent compile of the same automation.
  const attemptRunning = latest?.status === "running";
  const busy = phase !== "idle" || attemptRunning;
  const failure =
    latest?.status === "fail" ? (latest.error ?? "Compile failed.") : null;
  // A compile is a real coding-agent run and routinely takes minutes, not
  // seconds. Without a clock, "Compiling…" over an indeterminate spinner is
  // indistinguishable from a hang, and the honest answer ("it has been 4
  // minutes, that is normal") is the one thing the rail can offer while it
  // waits. Ticks only while a turn is open, so an idle rail re-renders never.
  const elapsed = useElapsedLabel(attemptRunning ? latest.startedAt : null);
  const verdict: { tone: string; label: string; detail: string } = isCreate
    ? {
        detail:
          "Save this automation to compile your instructions into a runnable plan.",
        label: "Not compiled",
        tone: "draft",
      }
    : phase === "compiling" || latest?.status === "running"
      ? {
          detail: "Turning your instructions into a deterministic plan.",
          label: "Compiling…",
          tone: "running",
        }
      : failure
        ? {
            detail: "The instructions could not be turned into a plan.",
            label: "Compile failed",
            tone: "failed",
          }
        : latest
          ? dirty
            ? {
                detail:
                  "The instructions changed since the last compile. Recompile to apply them.",
                label: "Plan is stale",
                tone: "paused",
              }
            : {
                detail: `Compiled ${latest.whenLabel}.`,
                label: "Plan ready",
                tone: "active",
              }
          : {
              detail:
                "Compile once to turn these instructions into a plan that can run.",
              label: "No plan yet",
              tone: "draft",
            };

  return (
    <aside
      className={styles.rail}
      data-testid="automation-compile-pane"
      data-tone={verdict.tone}
    >
      <section className={styles.verdict}>
        <div className={styles.verdictHead}>
          <span className={au.auStatus} data-tone={verdict.tone}>
            <span className={au.auStatusIc} aria-hidden="true">
              <Icon
                name={
                  verdict.tone === "running"
                    ? "Loader"
                    : verdict.tone === "failed"
                      ? "AlertTriangle"
                      : verdict.tone === "active"
                        ? "CheckCircle"
                        : "Braces"
                }
                size={11}
              />
            </span>
            <span data-testid="compile-verdict">{verdict.label}</span>
          </span>
          {elapsed ? (
            <span className={styles.elapsed} data-testid="compile-elapsed">
              {elapsed}
            </span>
          ) : null}
          <span className={styles.verdictSpacer} />
          {isCreate ? null : (
            <button
              type="button"
              className={styles.runsLink}
              onClick={onOpenRuns}
              title="This automation's execution history"
            >
              <span>Runs</span>
              <Icon name="ArrowRight" size={12} />
            </button>
          )}
        </div>
        <p className={styles.verdictDetail}>{verdict.detail}</p>
        {failure ? (
          <div className={styles.failure}>
            <pre className={styles.failureText} data-testid="compile-failure">
              {failure}
            </pre>
            {/* The only cure is upstream. Rather than offer a second place to
                type, send the owner back to the one field that authors this. */}
            <button
              type="button"
              className={styles.failureFix}
              data-testid="compile-edit-instructions"
              onClick={onEditInstructions}
            >
              <Icon name="ArrowLeft" size={11} />
              <span>Edit the instructions</span>
            </button>
          </div>
        ) : null}
        {isCreate ? null : (
          <div className={styles.verdictActions}>
            <button
              type="button"
              className={cx(au.auBtn, au.auBtnPrimary)}
              disabled={busy}
              data-testid="compile-now"
              onClick={doCompile}
            >
              <Icon name="Bolt" size={14} />
              <span>
                {phase === "compiling" || attemptRunning
                  ? "Compiling…"
                  : dirty
                    ? "Recompile"
                    : "Compile"}
              </span>
            </button>
            <button
              type="button"
              className={cx(au.auBtn, au.auBtnGhost)}
              disabled={busy || !latest || latest.status !== "ok"}
              data-testid="compile-test-run"
              title={
                latest?.status === "ok"
                  ? "Run the compiled plan once, here"
                  : "Compile successfully first"
              }
              onClick={doTest}
            >
              <Icon name="Beaker" size={14} />
              <span>{phase === "testing" ? "Testing…" : "Test run"}</span>
            </button>
          </div>
        )}
      </section>

      {isCreate ? null : (
        <section className={styles.stepsBand}>
          <div className={styles.bandHead}>
            <h3 className={styles.bandTitle}>
              {watched?.kind === "test" ? "Test run" : "Compile steps"}
            </h3>
            {watched ? (
              <button
                type="button"
                className={styles.bandLink}
                onClick={() => onOpenRun(watched.turnId)}
              >
                <span>Full trace</span>
                <Icon name="ArrowRight" size={11} />
              </button>
            ) : null}
          </div>
          {steps.length > 0 ? (
            <ol className={styles.steps}>
              {steps.map((step) => (
                <StepRow key={step.itemId} step={step} />
              ))}
            </ol>
          ) : (
            <p className={styles.bandEmpty}>
              {busy
                ? "Waiting for the first step…"
                : "Compile to watch each step of the plan being built."}
            </p>
          )}
          {attempts.length > 1 ? (
            <details className={styles.history}>
              <summary>{attempts.length} attempts</summary>
              <ul className={styles.historyList}>
                {attempts.map((attempt) => (
                  <li key={attempt.turnId}>
                    <button
                      type="button"
                      className={styles.historyRow}
                      data-status={attempt.status}
                      data-active={String(watched?.turnId === attempt.turnId)}
                      onClick={() => {
                        setWatched({ kind: "compile", turnId: attempt.turnId });
                        void loadTurnSteps(attempt.turnId)
                          .then(setSteps)
                          .catch(() => setSteps([]));
                      }}
                    >
                      <span className={styles.historyDot} aria-hidden="true" />
                      <span>{attempt.whenLabel}</span>
                      <span className={styles.historyOutcome}>
                        {attempt.status === "ok"
                          ? "succeeded"
                          : attempt.status === "fail"
                            ? "failed"
                            : "running"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>
      )}

      {isCreate ? null : (
        <section className={styles.artifactBand}>
          <button
            type="button"
            className={styles.bandToggle}
            aria-expanded={showArtifacts}
            onClick={() => setShowArtifacts((v) => !v)}
          >
            <Icon
              name={showArtifacts ? "ChevronDown" : "ChevronRight"}
              size={12}
            />
            <span>Compiled plan</span>
            <span className={styles.bandToggleHint}>
              handler.js · automation.json
            </span>
          </button>
          {showArtifacts ? (
            <AutomationCompileArtifacts
              source={source}
              file={file}
              onFile={setFile}
            />
          ) : null}
        </section>
      )}
    </aside>
  );
}
