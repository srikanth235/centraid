import type { JSX, ReactNode } from 'react';
import { Button } from '../ui/index.js';
import { formatBytes } from '../../format.js';
import {
  recoverStageOf,
  type RecoverEstimate,
  type RecoverFound,
  type RecoverPhase,
  type RecoverReportDTO,
  type RecoverStage,
} from '../../gateway-client-recover.js';
import styles from './RecoverScreen.module.css';

/*
 * The presentational step views for RecoverScreen (issue #439 §UI flow), split
 * out so the orchestrator stays under the file-size cap. Each is a pure
 * value→JSX view over injected props; the state machine + gateway bridge live in
 * RecoverScreen.tsx. None of these strings utters protocol vocabulary.
 */

const STAGES: { id: RecoverStage; label: string }[] = [
  { id: 'fetching', label: 'Fetching your vault' },
  { id: 'replaying', label: 'Replaying recent changes' },
  { id: 'warming', label: 'Warming previews' },
];
const STAGE_ORDER: RecoverStage[] = ['fetching', 'replaying', 'warming', 'done'];

export function whenLabel(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'a recent moment';
  try {
    return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return new Date(ms).toLocaleString();
  }
}

export function sizeLabel(bytes: number | null | undefined): string {
  return typeof bytes === 'number' ? formatBytes(bytes) : 'your data';
}

/** The dark full-screen stage every step sits on (onboarding's visual language). */
export function Stage({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className={styles.view} data-mounted="true">
      <div className={styles.stageBg} aria-hidden="true" />
      <div className={styles.stageGlow} aria-hidden="true" />
      <div className={styles.card} data-theme="dark">
        <div className={styles.eyebrow}>
          <span className={styles.eyebrowDot} aria-hidden="true" />
          CENTRAID
        </div>
        {children}
      </div>
    </div>
  );
}

function StageStepper({ current }: { current: RecoverStage }): JSX.Element {
  const idx = STAGE_ORDER.indexOf(current);
  return (
    <ol className={styles.stages}>
      {STAGES.map((stage) => {
        const pos = STAGE_ORDER.indexOf(stage.id);
        const state = pos < idx ? 'done' : pos === idx ? 'active' : 'todo';
        return (
          <li key={stage.id} className={styles.stage} data-state={state}>
            <span className={styles.stageDot} aria-hidden="true" />
            <span className={styles.stageLabel}>{stage.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function FoundStep({
  found,
  busy,
  onRecover,
  onUseDifferentKit,
}: {
  found: RecoverFound;
  busy: boolean;
  onRecover: () => void;
  onUseDifferentKit: () => void;
}): JSX.Element {
  return (
    <Stage>
      <h1 className={styles.title}>
        Found your <em>vault</em>.
      </h1>
      <p className={styles.foundLead}>Everything's here, safe as of {whenLabel(found.asOfMs)}.</p>
      <p className={styles.foundMeta}>
        {sizeLabel(found.sizeBytes)} · hosted at {found.providerHost}
      </p>
      <Button
        variant="primary"
        className={styles.cta}
        label={busy ? 'Starting…' : 'Recover this vault'}
        disabled={busy}
        onClick={onRecover}
      />
      <button type="button" className={styles.backBtn} onClick={onUseDifferentKit}>
        Use a different kit
      </button>
    </Stage>
  );
}

export function ConfirmStep({
  estimate,
  busy,
  onConfirm,
  onCancel,
}: {
  estimate: RecoverEstimate;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <Stage>
      <h1 className={styles.title}>
        Before we <em>start</em>.
      </h1>
      <p className={styles.sub}>
        Your provider charges for downloads. Recovering will pull about{' '}
        {sizeLabel(estimate.sizeBytes)} to this computer. Ready?
      </p>
      <Button
        variant="primary"
        className={styles.cta}
        label={busy ? 'Starting…' : 'Yes, recover'}
        disabled={busy}
        onClick={onConfirm}
      />
      <button type="button" className={styles.backBtn} onClick={onCancel}>
        Not now
      </button>
    </Stage>
  );
}

export function ProgressStep({ phase }: { phase: RecoverPhase }): JSX.Element {
  return (
    <Stage>
      <h1 className={styles.title}>
        Bringing your vault <em>back</em>.
      </h1>
      <p className={styles.sub}>
        This can take a few minutes. You can leave this screen — it keeps going, and the app opens
        the moment your things are ready.
      </p>
      <StageStepper current={recoverStageOf(phase)} />
    </Stage>
  );
}

export function LandingStep({
  report,
  onEnter,
}: {
  report: RecoverReportDTO | null;
  onEnter: () => void;
}): JSX.Element {
  const quarantine = report?.quarantine ?? [];
  return (
    <Stage>
      <h1 className={styles.title}>
        You're <em>back</em>.
      </h1>
      <p className={styles.foundLead}>Recovered as of {whenLabel(report?.recoveredAsOf)}.</p>
      {quarantine.length > 0 ? (
        <p className={styles.sub}>
          A few things are waiting for your OK — sent items to approve, connections to reconnect,
          and paused automations. You'll find them in Approvals and Connections.
        </p>
      ) : null}
      <Button variant="primary" className={styles.cta} label="Enter Centraid" onClick={onEnter} />
    </Stage>
  );
}

export function StopStep({
  title,
  message,
  onStartOver,
  onBack,
}: {
  title: string;
  message: string;
  onStartOver: () => void;
  onBack: () => void;
}): JSX.Element {
  return (
    <Stage>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.sub}>{message}</p>
      <Button variant="primary" className={styles.cta} label="Start over" onClick={onStartOver} />
      <button type="button" className={styles.backBtn} onClick={onBack}>
        Back
      </button>
    </Stage>
  );
}

export function FailedStep({
  message,
  busy,
  onRetry,
  onStartOver,
}: {
  message: string;
  busy: boolean;
  onRetry: () => void;
  onStartOver: () => void;
}): JSX.Element {
  return (
    <Stage>
      <h1 className={styles.title}>
        That didn't <em>finish</em>.
      </h1>
      <p className={styles.sub}>{message}</p>
      <Button
        variant="primary"
        className={styles.cta}
        label={busy ? 'Trying…' : 'Try again'}
        disabled={busy}
        onClick={onRetry}
      />
      <button type="button" className={styles.backBtn} onClick={onStartOver}>
        Start over
      </button>
    </Stage>
  );
}
