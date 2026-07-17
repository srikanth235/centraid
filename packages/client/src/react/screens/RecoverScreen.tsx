import { useEffect, useRef, useState, type DragEvent, type JSX } from 'react';
import { Button } from '../ui/index.js';
import {
  type RecoverDiscovery,
  type RecoverEstimate,
  type RecoverEvent,
  type RecoverFound,
  type RecoverJobRecordDTO,
  type RecoverKitResult,
  type RecoverPhase,
  type RecoverReportDTO,
  type RecoverStartResult,
  type RecoverStatus,
} from '../../gateway-client-recover.js';
import styles from './RecoverScreen.module.css';
import {
  ConfirmStep,
  FailedStep,
  FoundStep,
  LandingStep,
  ProgressStep,
  Stage,
  StopStep,
} from './RecoverSteps.js';

/**
 * The fresh-gateway "Recover my vault" branch (issue #439 §UI flow) — the shell
 * that turns a pasted/dropped recovery kit + a provider key into a live vault.
 * Presentational: every gateway call is an injected bridge prop (no direct
 * window.CentraidApi / fetch here), matching the settings screens. It walks the
 * user through EXACTLY two inputs (kit, key) and ONE confirmation (only shown
 * when the provider bills egress), and speaks no protocol vocabulary — no
 * "snapshot", "seq", "store class", "WAL", or "lazy" reaches the screen.
 *
 * States: paste/drop the kit → enter the provider key → the one "found your
 * vault" card → (metered-egress only) a price confirm → progress in three user
 * phases over SSE → landing with the quarantine hand-off, or a human dead-end
 * (nothing to recover / needs an update / this machine isn't fresh / wrong key).
 * On a page reload mid-restore it reattaches via /status.
 */

export interface RecoverScreenBridge {
  validateKit: (kitDocument: unknown) => Promise<RecoverKitResult>;
  discover: (input: { kit: unknown; apiKey: string }) => Promise<RecoverDiscovery>;
  start: (input: {
    kit: unknown;
    apiKey: string;
    confirmed?: boolean;
  }) => Promise<RecoverStartResult>;
  status: () => Promise<RecoverStatus>;
  streamEvents: (
    jobId: string,
    onEvent: (ev: RecoverEvent) => void,
    signal: AbortSignal,
  ) => Promise<void>;
}

export interface RecoverScreenProps extends RecoverScreenBridge {
  /** The recovered vault is mounted — complete onboarding + boot the app. */
  onRecovered: () => void | Promise<void>;
  /** Return to the first-run "Start fresh / Recover" choice. */
  onBack: () => void;
}

type View =
  | { s: 'kit' }
  | { s: 'key'; kit: unknown; host: string }
  | { s: 'found'; kit: unknown; apiKey: string; found: RecoverFound }
  | { s: 'confirm'; kit: unknown; apiKey: string; estimate: RecoverEstimate }
  | { s: 'progress'; jobId: string; phase: RecoverPhase }
  | { s: 'landing'; report: RecoverReportDTO | null }
  | { s: 'stop'; title: string; message: string }
  | { s: 'failed'; message: string };

function parseKit(text: string): { kit: unknown } | { error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { error: 'Paste your recovery kit, or drop the file above.' };
  try {
    return { kit: JSON.parse(trimmed) as unknown };
  } catch {
    return { error: "That doesn't look like a recovery kit — paste the whole file." };
  }
}

export default function RecoverScreen({
  validateKit,
  discover,
  start,
  status,
  streamEvents,
  onRecovered,
  onBack,
}: RecoverScreenProps): JSX.Element {
  const [view, setView] = useState<View>({ s: 'kit' });
  const [kitText, setKitText] = useState('');
  const [kitError, setKitError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Held so an in-session retry can re-run start(); a reattach-after-reload has
  // neither (the daemon owns the job, the secrets never persist) → retry there
  // just starts over.
  const sessionRef = useRef<{ kit: unknown; apiKey: string } | null>(null);
  const reportRef = useRef<RecoverReportDTO | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const attachTo = (job: RecoverJobRecordDTO): void => {
    if (job.state === 'running') setView({ s: 'progress', jobId: job.jobId, phase: job.phase });
    else if (job.state === 'done') {
      reportRef.current = job.report ?? null;
      setView({ s: 'landing', report: job.report ?? null });
    } else {
      setView({
        s: 'failed',
        message: job.error || 'The recovery stopped before it finished. You can try again.',
      });
    }
  };

  // Reattach: a restore the daemon is (or was) running survives this screen
  // closing, so on mount fold the live job in.
  useEffect(() => {
    let alive = true;
    void status()
      .then((st) => {
        if (alive && st.job) attachTo(st.job);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (#439) mount-once reattach
  }, []);

  // Progress SSE: replay-then-live; a dropped stream reconnects (the gateway
  // replays every phase, so reconnecting is idempotent).
  const [reconnect, setReconnect] = useState(0);
  const jobId = view.s === 'progress' ? view.jobId : '';
  useEffect(() => {
    if (!jobId) return;
    const controller = new AbortController();
    let retimer: ReturnType<typeof setTimeout> | undefined;
    void streamEvents(
      jobId,
      (ev) => {
        if (ev.kind === 'phase') {
          setView((v) => (v.s === 'progress' && v.jobId === jobId ? { ...v, phase: ev.phase } : v));
        } else if (ev.kind === 'report') {
          reportRef.current = ev.report;
        } else if (ev.kind === 'end') {
          if (ev.state === 'done') setView({ s: 'landing', report: reportRef.current });
          else
            setView({
              s: 'failed',
              message: 'The recovery stopped before it finished. You can try again.',
            });
        }
      },
      controller.signal,
    ).catch(() => {
      if (!controller.signal.aborted) retimer = setTimeout(() => setReconnect((n) => n + 1), 1500);
    });
    return () => {
      controller.abort();
      if (retimer) clearTimeout(retimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (#439) keyed on jobId + reconnect nonce
  }, [jobId, reconnect]);

  const submitKit = async (): Promise<void> => {
    const parsed = parseKit(kitText);
    if ('error' in parsed) {
      setKitError(parsed.error);
      return;
    }
    setBusy(true);
    setKitError(null);
    try {
      const result = await validateKit(parsed.kit);
      if (!result.ok) {
        setKitError(result.message);
        return;
      }
      const host = result.targets[0]?.providerHost ?? 'your provider';
      setApiKey('');
      setKeyError(null);
      setView({ s: 'key', kit: parsed.kit, host });
    } finally {
      setBusy(false);
    }
  };

  const submitKey = async (kit: unknown): Promise<void> => {
    if (apiKey.trim().length === 0) return;
    setBusy(true);
    setKeyError(null);
    try {
      const d = await discover({ kit, apiKey: apiKey.trim() });
      if (d.found) {
        sessionRef.current = { kit, apiKey: apiKey.trim() };
        setView({ s: 'found', kit, apiKey: apiKey.trim(), found: d });
        return;
      }
      if (d.reason === 'wrong_key') {
        setKeyError("That key didn't work — check the access key in your invite email.");
      } else if (d.reason === 'no_snapshot') {
        setView({
          s: 'stop',
          title: 'Nothing to recover yet',
          message: "This kit doesn't have anything backed up with your provider yet.",
        });
      } else if (d.reason === 'incompatible') {
        setView({
          s: 'stop',
          title: 'Time to update',
          message:
            'This backup was made by a newer version of Centraid. Update the app, then recover again.',
        });
      } else if (d.reason === 'invalid_kit') {
        setKitError(d.message);
        setView({ s: 'kit' });
      } else {
        setKeyError(d.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const runStart = async (kit: unknown, key: string, confirmed: boolean): Promise<void> => {
    setBusy(true);
    try {
      const r = await start({ kit, apiKey: key, ...(confirmed ? { confirmed } : {}) });
      if (r.started) {
        reportRef.current = null;
        setView({ s: 'progress', jobId: r.jobId, phase: 'discovering' });
        return;
      }
      if (r.reason === 'confirm_required') {
        setView({ s: 'confirm', kit, apiKey: key, estimate: r.estimate });
      } else if (r.reason === 'in_progress') {
        const st = await status();
        if (st.job) attachTo(st.job);
        else setView({ s: 'failed', message: r.message });
      } else if (r.reason === 'not_fresh') {
        setView({
          s: 'stop',
          title: 'This computer already has a vault',
          message: 'Recovery only runs on a brand-new setup — this machine already has data on it.',
        });
      } else if (r.reason === 'incompatible') {
        setView({
          s: 'stop',
          title: 'Time to update',
          message:
            'This backup was made by a newer version of Centraid. Update the app, then recover again.',
        });
      } else if (r.reason === 'wrong_key') {
        setKeyError("That key didn't work — check the access key in your invite email.");
        setView({ s: 'key', kit, host: 'your provider' });
      } else {
        setView({ s: 'failed', message: r.message });
      }
    } finally {
      setBusy(false);
    }
  };

  const beginRecover = (v: Extract<View, { s: 'found' }>): void => {
    if (v.found.restoreCostClass === 'metered-egress') {
      setView({
        s: 'confirm',
        kit: v.kit,
        apiKey: v.apiKey,
        estimate: {
          sizeBytes: v.found.sizeBytes,
          asOfMs: v.found.asOfMs,
          restoreCostClass: v.found.restoreCostClass,
          lazyAvailable: v.found.lazyAvailable,
        },
      });
      return;
    }
    void runStart(v.kit, v.apiKey, false);
  };

  const retryFromFailure = (): void => {
    const session = sessionRef.current;
    if (session) void runStart(session.kit, session.apiKey, true);
    else startOver();
  };

  const startOver = (): void => {
    sessionRef.current = null;
    reportRef.current = null;
    setKitText('');
    setKitError(null);
    setApiKey('');
    setKeyError(null);
    setView({ s: 'kit' });
  };

  const onDropKit = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    void file
      .text()
      .then((text) => {
        setKitText(text);
        setKitError(null);
      })
      .catch(() => setKitError("Couldn't read that file — paste the kit instead."));
  };

  const onPickFile = (file: File | undefined): void => {
    if (!file) return;
    void file
      .text()
      .then((text) => {
        setKitText(text);
        setKitError(null);
      })
      .catch(() => setKitError("Couldn't read that file — paste the kit instead."));
  };

  if (view.s === 'kit') {
    return (
      <Stage>
        <h1 className={styles.title}>
          Recover your <em>vault</em>.
        </h1>
        <p className={styles.sub}>
          Drop the recovery kit you saved when you set up hosted storage — or paste it below.
        </p>
        <div
          className={styles.dropZone}
          data-dragging={dragging ? 'true' : 'false'}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDropKit}
        >
          <textarea
            className={styles.textarea}
            placeholder="Paste your recovery kit here…"
            spellCheck={false}
            value={kitText}
            aria-label="Recovery kit"
            onChange={(e) => {
              setKitText(e.target.value);
              setKitError(null);
            }}
          />
          <div className={styles.dropHint}>
            Drop the file here, or{' '}
            <button
              type="button"
              className={styles.linkBtn}
              onClick={() => fileRef.current?.click()}
            >
              choose a file
            </button>
            .
            <input
              ref={fileRef}
              type="file"
              className={styles.hiddenFile}
              tabIndex={-1}
              aria-label="Recovery kit file"
              onChange={(e) => onPickFile(e.target.files?.[0])}
            />
          </div>
        </div>
        {kitError ? (
          <div className={styles.error} role="alert">
            {kitError}
          </div>
        ) : null}
        <Button
          variant="primary"
          className={styles.cta}
          label={busy ? 'Checking…' : 'Continue'}
          disabled={busy || kitText.trim().length === 0}
          onClick={() => void submitKit()}
        />
        <button type="button" className={styles.backBtn} onClick={onBack}>
          Back
        </button>
      </Stage>
    );
  }

  if (view.s === 'key') {
    return (
      <Stage>
        <h1 className={styles.title}>
          One more <em>thing</em>.
        </h1>
        <p className={styles.sub}>
          Enter the access key for your storage at {view.host}. You'll find it in your invite email.
        </p>
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            void submitKey(view.kit);
          }}
        >
          <label className={styles.fieldLabel} htmlFor="cd-rec-key">
            Access key
          </label>
          <input
            id="cd-rec-key"
            className={styles.input}
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label="Access key"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              setKeyError(null);
            }}
          />
          {keyError ? (
            <div className={styles.error} role="alert">
              {keyError}
            </div>
          ) : null}
          <Button
            variant="primary"
            className={styles.cta}
            label={busy ? 'Looking…' : 'Find my vault'}
            disabled={busy || apiKey.trim().length === 0}
            onClick={() => void submitKey(view.kit)}
          />
        </form>
        <button type="button" className={styles.backBtn} onClick={() => setView({ s: 'kit' })}>
          Back
        </button>
      </Stage>
    );
  }

  if (view.s === 'found') {
    return (
      <FoundStep
        found={view.found}
        busy={busy}
        onRecover={() => beginRecover(view)}
        onUseDifferentKit={startOver}
      />
    );
  }

  if (view.s === 'confirm') {
    const cancel = (): void => {
      if (sessionRef.current) void submitKey(view.kit);
      else setView({ s: 'kit' });
    };
    return (
      <ConfirmStep
        estimate={view.estimate}
        busy={busy}
        onConfirm={() => void runStart(view.kit, view.apiKey, true)}
        onCancel={cancel}
      />
    );
  }

  if (view.s === 'progress') {
    return <ProgressStep phase={view.phase} />;
  }

  if (view.s === 'landing') {
    return <LandingStep report={view.report} onEnter={() => void onRecovered()} />;
  }

  if (view.s === 'stop') {
    return (
      <StopStep title={view.title} message={view.message} onStartOver={startOver} onBack={onBack} />
    );
  }

  return (
    <FailedStep
      message={view.message}
      busy={busy}
      onRetry={retryFromFailure}
      onStartOver={startOver}
    />
  );
}
