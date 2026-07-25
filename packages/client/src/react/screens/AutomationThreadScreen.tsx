// governance: allow-repo-hygiene file-size-limit (#539) single cohesive screen component (header/consent-strip/chat-turn spine/steering composer of one thread surface); splitting would fragment one visual unit
import { type FormEvent, type JSX, useCallback, useEffect, useRef, useState } from 'react';
import type { IconName } from '@centraid/design-tokens';
import { Icon } from '../ui/index.js';
import { cx } from '../ui/cx.js';
import au from '../styles/automation.module.css';
import styles from './AutomationThreadScreen.module.css';
import Message, { type MessageCallbacks } from './AssistantMessage.js';
import type {
  AsstMsgDTO,
  AuStatusKind,
  AutomationThreadBridgeProps,
  AutomationThreadData,
  ConsentDecision,
  ConsentKind,
  GrantDTO,
  OutboxItemDTO,
  ParkedItemDTO,
  ThreadRunDTO,
} from '../screen-contracts.js';

// The automation thread — "the automation IS a conversation" (Automations UI
// revamp, receipts/issue-387-automations-ui-revamp.md; chat rendering +
// steering composer, receipts/issue-539-automations-chat-thread.md). Replaces
// AutomationViewScreen at the `automation-view` route. Header (identity +
// trigger chips + enable/run/edit/delete), an inline consent strip
// (parked/outbox/grants — consent is reviewed here, never begged at runtime),
// then the thread itself: every fire is a chat turn on a flight-recorder spine
// (oldest→newest, date-grouped) — the run summary is the message, telemetry
// sits in a quiet footer, and a failed run speaks as an error you can retry in
// place. A steering composer at the foot routes a reply through the existing
// conversational-revision path (`onSendMessage`). Purely presentational: the
// route wrapper (`AutomationViewRoute.tsx`) owns IO, confirm dialogs, toasts,
// and navigation.

/**
 * `AutomationThreadData` plus two additive, OPTIONAL route-derived fields —
 * both documented DTO gaps (see the file's PR / lane report):
 *
 * - `triggerDetail`: `AutomationThreadHeaderDTO` carries only the human
 *   `triggerSummary` string (e.g. "Every day at 8am") and relative
 *   `nextRuns` labels — no raw cron expression and no data/condition
 *   entity+cadence detail (that richer shape lives on `AutomationHeroDTO`,
 *   the screen this one supersedes). The route derives it from the SAME
 *   row via `automationsData.ts`'s already-exported `deriveAutomationHero`
 *   (no new endpoint), so the trigger-chips row can show the mono cron expr
 *   / "watches `<entity>` · every `<cadence>`" text the brief calls for.
 * - `runTokens`: `ThreadRunDTO` carries `costUsd`/`durationMs` but no
 *   per-run token count. The route derives a `runId → tokens` map from the
 *   same `listAutomationTurns` call `automationThreadData.ts` already makes
 *   internally, so the run meta can show a token count when present.
 *
 * Both are optional so a bare `AutomationThreadData` — the documented
 * contract shape — still satisfies this prop at the type level; the screen
 * degrades gracefully (no cron/entity chip beyond the human summary, no
 * token figure) when they're absent.
 */
export interface AutomationThreadDataEx extends AutomationThreadData {
  triggerDetail?: {
    cronExprs: string[];
    dataDetail: { entities: string[]; everyLabel: string | null } | null;
    conditionDetail: { entity: string; everyLabel: string | null; whereText: string } | null;
  };
  runTokens?: Record<string, number>;
}

export interface AutomationThreadScreenProps extends Omit<AutomationThreadBridgeProps, 'loadData'> {
  loadData: () => Promise<AutomationThreadDataEx | null>;
}

const STATUS_ICON: Record<AuStatusKind, IconName> = {
  active: 'Power',
  paused: 'Pause',
  draft: 'Pencil',
  running: 'Loader',
  success: 'CheckCircle',
  failed: 'AlertTriangle',
};

/**
 * Backoff between rejoin attempts for a dropped/refused turn stream. Bounded
 * on purpose: four quick tries cover a gateway restart or a momentarily full
 * subscriber cap, and anything longer is a real outage the reader should be
 * told about rather than a spinner that never resolves.
 */
const WATCH_REJOIN_DELAYS_MS = [500, 1500, 4000, 10_000];

function withoutId(current: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (!current.has(id)) return current;
  const next = new Set(current);
  next.delete(id);
  return next;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}
function fmtCost(usd: number): string {
  return `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`;
}
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`;
}
function relTime(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

interface RunGroup {
  dateGroup: string;
  runs: ThreadRunDTO[];
}
/** Oldest→newest within each calendar-day group, groups in the order their
 *  first run appears — the thread reads top-to-bottom like a growing
 *  conversation, most recent at the bottom. */
function groupRuns(runs: readonly ThreadRunDTO[]): RunGroup[] {
  const chronological = [...runs].sort((a, b) => a.startedAt - b.startedAt);
  const groups: RunGroup[] = [];
  for (const run of chronological) {
    const last = groups[groups.length - 1];
    if (last && last.dateGroup === run.dateGroup) last.runs.push(run);
    else groups.push({ dateGroup: run.dateGroup, runs: [run] });
  }
  return groups;
}

function TriggerChips({
  header,
  triggerDetail,
  regenBusy,
  onCopyWebhook,
  onRegenerate,
}: {
  header: AutomationThreadData['header'];
  triggerDetail: AutomationThreadDataEx['triggerDetail'];
  regenBusy: boolean;
  onCopyWebhook: (url: string) => void;
  onRegenerate: () => void;
}): JSX.Element {
  const cronExprs = triggerDetail?.cronExprs ?? [];
  const dataDetail = triggerDetail?.dataDetail ?? null;
  const conditionDetail = triggerDetail?.conditionDetail ?? null;
  const hasStructured =
    cronExprs.length > 0 || !!header.webhook || !!dataDetail || !!conditionDetail;
  const triggerKind =
    cronExprs.length > 0
      ? 'cron'
      : header.webhook
        ? 'webhook'
        : dataDetail
          ? 'data'
          : conditionDetail
            ? 'condition'
            : 'manual';

  return (
    <div className={styles.chips} data-trigger-kind={triggerKind}>
      {cronExprs.map((expr) => (
        <span key={expr} className={styles.chip}>
          <span className={styles.chipIc} aria-hidden="true">
            <Icon name="Braces" size={12} />
          </span>
          <code>{expr}</code>
          {header.nextRuns[0] ? (
            <span className={styles.chipNext}>next {header.nextRuns[0]}</span>
          ) : null}
        </span>
      ))}
      {header.webhook ? (
        header.webhook.pending || !header.webhook.url ? (
          <span className={styles.chip} data-provisioning="true">
            <span className={styles.chipIc} aria-hidden="true">
              <Icon name="Loader" size={12} />
            </span>
            <span>Provisioning endpoint…</span>
          </span>
        ) : (
          <span className={styles.chip}>
            <span className={styles.chipIc} aria-hidden="true">
              <Icon name="Webhook" size={12} />
            </span>
            <code className={styles.chipUrl} data-testid="automation-webhook-url">
              {header.webhook.url}
            </code>
            <button
              type="button"
              className={styles.chipIconBtn}
              aria-label="Copy webhook URL"
              title="Copy webhook URL"
              onClick={() => header.webhook?.url && onCopyWebhook(header.webhook.url)}
            >
              <Icon name="Copy" size={12} />
            </button>
            <button
              type="button"
              className={styles.chipIconBtn}
              aria-label="Regenerate secret"
              title="Regenerate secret"
              disabled={regenBusy}
              onClick={onRegenerate}
            >
              <Icon name="Refresh" size={12} />
            </button>
          </span>
        )
      ) : null}
      {dataDetail ? (
        <span className={styles.chip}>
          <span className={styles.chipIc} aria-hidden="true">
            <Icon name="Folder" size={12} />
          </span>
          <span>
            watches <code>{dataDetail.entities.join(', ')}</code>
            {dataDetail.everyLabel ? ` · ${dataDetail.everyLabel.toLowerCase()}` : ''}
          </span>
        </span>
      ) : null}
      {conditionDetail ? (
        <span className={styles.chip}>
          <span className={styles.chipIc} aria-hidden="true">
            <Icon name="Filter" size={12} />
          </span>
          <span>
            watches <code>{conditionDetail.entity}</code>
            {conditionDetail.everyLabel ? ` · ${conditionDetail.everyLabel.toLowerCase()}` : ''}
          </span>
        </span>
      ) : null}
      {!hasStructured ? <span className={styles.chip}>{header.triggerSummary}</span> : null}
    </div>
  );
}

function ParkedCard({
  item,
  busy,
  onDecide,
}: {
  item: ParkedItemDTO;
  busy: boolean;
  onDecide: (decision: ConsentDecision) => void;
}): JSX.Element {
  return (
    <div className={styles.consentCard} data-kind="parked">
      <span className={styles.consentIc} aria-hidden="true">
        <Icon name="Clock" size={14} />
      </span>
      <div className={styles.consentBody}>
        <div className={styles.consentTitle}>
          Parked: <code>{item.command}</code> — waiting for you
        </div>
        <div className={styles.consentMeta}>{relTime(item.parkedAt)}</div>
      </div>
      <div className={styles.consentActions}>
        <button
          type="button"
          className={cx(au.auBtn, au.auBtnGhost, styles.consentBtnSm)}
          disabled={busy}
          onClick={() => onDecide('discard')}
        >
          Dismiss
        </button>
        <button
          type="button"
          className={cx(au.auBtn, au.auBtnPrimary, styles.consentBtnSm)}
          disabled={busy}
          onClick={() => onDecide('approve')}
        >
          Approve
        </button>
      </div>
    </div>
  );
}

function OutboxCard({
  item,
  busy,
  onDecide,
}: {
  item: OutboxItemDTO;
  busy: boolean;
  onDecide: (decision: ConsentDecision, alwaysAllow?: boolean) => void;
}): JSX.Element {
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const pending = item.status === 'pending';
  return (
    <div className={styles.consentCard} data-kind="outbox" data-status={item.status}>
      <span className={styles.consentIc} aria-hidden="true">
        <Icon name="Send" size={14} />
      </span>
      <div className={styles.consentBody}>
        <div className={styles.consentTitle}>
          Staged: {item.verb} {item.connectionLabel} to <code>{item.target}</code>
        </div>
        <div className={styles.consentMeta}>
          {item.connectionLabel} · {relTime(item.stagedAt)}
        </div>
        {pending ? (
          <label className={styles.consentCheck}>
            <input
              type="checkbox"
              checked={alwaysAllow}
              onChange={(e) => setAlwaysAllow(e.target.checked)}
            />
            Always allow
          </label>
        ) : (
          <div className={styles.consentDecided}>{item.status}</div>
        )}
      </div>
      {pending ? (
        <div className={styles.consentActions}>
          <button
            type="button"
            className={cx(au.auBtn, au.auBtnGhost, styles.consentBtnSm)}
            disabled={busy}
            onClick={() => onDecide('discard')}
          >
            Reject
          </button>
          <button
            type="button"
            className={cx(au.auBtn, au.auBtnPrimary, styles.consentBtnSm)}
            disabled={busy}
            onClick={() => onDecide('approve', alwaysAllow)}
          >
            Approve
          </button>
        </div>
      ) : null}
    </div>
  );
}

function GrantsLine({
  grants,
  busyId,
  onRevoke,
}: {
  grants: readonly GrantDTO[];
  busyId: string | null;
  onRevoke: (grantId: string) => void;
}): JSX.Element {
  return (
    <details className={styles.grantsLine}>
      <summary>
        {grants.length} standing grant{grants.length === 1 ? '' : 's'}
      </summary>
      <div className={styles.grantsList}>
        {grants.map((g) => (
          <div key={g.grantId} className={styles.grantRow}>
            <code>{g.verb}</code>
            <span className={styles.grantArrow} aria-hidden="true">
              <Icon name="ArrowRight" size={11} />
            </span>
            <code>{g.target}</code>
            <span className={styles.grantMeta}>{relTime(g.createdAt)}</span>
            <button
              type="button"
              className={cx(au.auBtn, au.auBtnGhost, styles.consentBtnSm)}
              disabled={busyId === g.grantId}
              onClick={() => onRevoke(g.grantId)}
            >
              Revoke
            </button>
          </div>
        ))}
      </div>
    </details>
  );
}

// The node icon sits on the thread spine and encodes the trigger *origin*
// (not just the run's outcome): a running run always spins its loader, a
// failed one shows the alert, otherwise we read the origin label — the only
// origin signal `ThreadRunDTO` carries — to distinguish a scheduled fire from
// a manual/webhook/data one. Keeps the chip honest without a DTO change.
function nodeIconFor(run: ThreadRunDTO): IconName {
  if (run.status === 'running') return 'Loader';
  if (run.status === 'fail') return 'AlertTriangle';
  const origin = run.originLabel.toLowerCase();
  if (origin.includes('manual')) return 'Play';
  if (origin.includes('webhook')) return 'Webhook';
  if (origin.includes('data') || origin.includes('watch')) return 'Folder';
  if (origin.includes('replay')) return 'Refresh';
  return 'Clock';
}

// One run = one chat turn. The automation "speaks" each time it fires: the
// spine node marks the trigger, the header names the origin + time, the run
// summary is the message body, and a quiet footer carries the telemetry. A
// failed run speaks as an error you can retry in place; either way "Details"
// opens the full step-by-step run-view. This is the compact register turned
// into a conversation, over the same `ThreadRunDTO` (issue #539).
function RunTurn({
  run,
  tokens,
  messages,
  traceLoading,
  traceFailed,
  watchLost,
  onLoadTrace,
  onRetryWatch,
  onOpen,
  onRerun,
  rerunBusy,
}: {
  run: ThreadRunDTO;
  tokens?: number;
  messages?: readonly AsstMsgDTO[];
  traceLoading: boolean;
  /** The cold trace read failed — the turn offers a retry instead of lying. */
  traceFailed: boolean;
  /** The live stream is gone after bounded rejoins — offer Reconnect. */
  watchLost: boolean;
  onLoadTrace: () => void;
  onRetryWatch: () => void;
  onOpen: () => void;
  onRerun: () => void;
  rerunBusy: boolean;
}): JSX.Element {
  const time = new Date(run.startedAt).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  const running = run.status === 'running';
  const failed = run.status === 'fail';
  const hasTrace = messages !== undefined;
  const messageCallbacks: MessageCallbacks = {
    hydrateRefs: () => undefined,
    wireCodeCopy: () => undefined,
    loadAttachmentImage: () => Promise.reject(new Error('automation attachments unavailable')),
    onCopyMessage: (text) => void navigator.clipboard?.writeText(text),
    onFeedback: () => undefined,
    onRegenerate: () => undefined,
    onRetryError: () => undefined,
    onPagerNav: () => undefined,
  };
  return (
    <article className={styles.turn} data-run-status={run.status} data-testid="run-entry">
      <span
        className={styles.node}
        data-run-status={run.status}
        data-spin={running ? 'true' : undefined}
        aria-hidden="true"
      >
        <Icon name={nodeIconFor(run)} size={12} />
      </span>
      <div className={styles.turnHead}>
        <span className={styles.turnOrigin}>{run.originLabel}</span>
        <span className={styles.turnTime}>{time}</span>
        <span className={styles.turnHeadSpacer} />
        {!running ? (
          <button type="button" className={styles.turnRerun} disabled={rerunBusy} onClick={onRerun}>
            <Icon name="Refresh" size={12} />
            <span>Run again</span>
          </button>
        ) : null}
      </div>

      {hasTrace ? (
        <div className={styles.turnTrace} data-testid="automation-turn-trace">
          {messages.length > 0 ? (
            messages.map((message, index) => (
              <Message
                key={message.msgId ?? `${message.kind}:${index}`}
                m={message}
                index={index}
                cb={messageCallbacks}
              />
            ))
          ) : (
            <div className={styles.turnGenerating}>
              <span className={styles.turnSpinner} aria-hidden="true" />
              <span>Working through your instructions…</span>
            </div>
          )}
        </div>
      ) : running ? (
        <div className={styles.turnGenerating}>
          <span className={styles.turnSpinner} aria-hidden="true" />
          <span>Working through your instructions…</span>
        </div>
      ) : failed ? (
        <div className={styles.turnError}>
          <div className={styles.turnErrorBody}>{run.summary}</div>
          <div className={styles.turnErrorActions}>
            <button
              type="button"
              className={cx(au.auBtn, au.auBtnPrimary, styles.turnErrorBtn)}
              disabled={rerunBusy}
              onClick={onRerun}
            >
              Try again
            </button>
            <button
              type="button"
              className={cx(au.auBtn, au.auBtnGhost, styles.turnErrorBtn)}
              data-testid="run-details"
              onClick={onOpen}
            >
              View details
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className={styles.turnBody}>{run.summary}</div>
          <div className={styles.turnFoot}>
            <span className={styles.turnOutcome} data-ok="true">
              <Icon name="CheckCircle" size={13} />
              <span>Done</span>
            </span>
            <span className={styles.turnTelem}>
              {run.durationMs !== null ? <span>{fmtDuration(run.durationMs)}</span> : null}
              {run.costUsd ? <span>{fmtCost(run.costUsd)}</span> : null}
              {tokens ? <span>{fmtTokens(tokens)}</span> : null}
            </span>
            <span className={styles.turnHeadSpacer} />
            <button
              type="button"
              className={styles.turnDetails}
              data-testid="show-trace"
              disabled={traceLoading}
              onClick={onLoadTrace}
            >
              <span>{traceLoading ? 'Loading…' : 'Show trace'}</span>
            </button>
            <button
              type="button"
              className={styles.turnDetails}
              data-testid="run-details"
              onClick={onOpen}
            >
              <span>Details</span>
              <Icon name="ArrowRight" size={12} />
            </button>
          </div>
        </>
      )}
      {!hasTrace && traceFailed ? (
        <div className={styles.turnNotice} data-testid="turn-trace-error">
          <div className={styles.turnErrorBody}>Couldn’t load this turn’s transcript.</div>
          <div className={styles.turnErrorActions}>
            <button
              type="button"
              className={cx(au.auBtn, au.auBtnGhost, styles.turnErrorBtn)}
              data-testid="retry-trace"
              disabled={traceLoading}
              onClick={onLoadTrace}
            >
              {traceLoading ? 'Retrying…' : 'Try again'}
            </button>
          </div>
        </div>
      ) : null}
      {watchLost && running ? (
        <div className={styles.turnNotice} data-testid="turn-watch-lost">
          <div className={styles.turnErrorBody}>
            Lost the live connection to this run. It may still be working.
          </div>
          <div className={styles.turnErrorActions}>
            <button
              type="button"
              className={cx(au.auBtn, au.auBtnGhost, styles.turnErrorBtn)}
              data-testid="rejoin-turn"
              onClick={onRetryWatch}
            >
              Reconnect
            </button>
          </div>
        </div>
      ) : null}
      {hasTrace && !running ? (
        <div className={styles.turnFoot}>
          <span className={styles.turnOutcome} data-ok={failed ? undefined : 'true'}>
            <Icon name={failed ? 'AlertTriangle' : 'CheckCircle'} size={13} />
            <span>{failed ? 'Failed' : 'Done'}</span>
          </span>
          <span className={styles.turnTelem}>
            {run.durationMs !== null ? <span>{fmtDuration(run.durationMs)}</span> : null}
            {run.costUsd ? <span>{fmtCost(run.costUsd)}</span> : null}
            {tokens ? <span>{fmtTokens(tokens)}</span> : null}
          </span>
          <span className={styles.turnHeadSpacer} />
          <button
            type="button"
            className={styles.turnDetails}
            data-testid="run-details"
            onClick={onOpen}
          >
            <span>Details</span>
            <Icon name="ArrowRight" size={12} />
          </button>
        </div>
      ) : null}
    </article>
  );
}

// The steering composer. Replying is how you refine an automation now: with
// "Apply to future runs" on, the message is a standing instruction the
// schedule keeps; off, it's a one-off note framed for this thread only. Both
// route through the existing conversational-revision path (`onSendMessage`).
function Composer({
  busy,
  onSend,
}: {
  busy: boolean;
  onSend: (text: string, applyFuture: boolean) => void;
}): JSX.Element {
  const [draft, setDraft] = useState('');
  const [applyFuture, setApplyFuture] = useState(true);
  const trimmed = draft.trim();
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (!trimmed) return;
    onSend(trimmed, applyFuture);
    setDraft('');
  };
  return (
    <form className={styles.composerWrap} onSubmit={submit}>
      <div className={styles.steerRow}>
        <button
          type="button"
          className={cx(styles.steerToggle, applyFuture && styles.steerToggleOn)}
          aria-pressed={applyFuture}
          disabled={busy}
          onClick={() => setApplyFuture((v) => !v)}
        >
          <span className={styles.steerSwitch} aria-hidden="true" />
          <span>Apply to future runs</span>
        </button>
        <span className={styles.steerHint}>
          {applyFuture
            ? 'Becomes a standing instruction the schedule keeps.'
            : "One-off — won't change the schedule."}
        </span>
      </div>
      <div className={styles.composer}>
        <input
          className={styles.composerInput}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Steer this automation, or ask a follow-up…"
          aria-label="Message this automation"
          disabled={busy}
        />
        <button
          type="submit"
          className={styles.composerSend}
          aria-label="Send"
          disabled={!trimmed || busy}
        >
          <Icon name="Send" size={15} />
        </button>
      </div>
    </form>
  );
}

export default function AutomationThreadScreen({
  loadData,
  loadTurnTrace,
  watchTurn,
  onBack,
  onEdit,
  onRetryCompile,
  onOpenRun,
  onRunNow,
  onToggleEnabled,
  onDecideConsent,
  onSendMessage,
  onCopyWebhook,
  onRotateWebhook,
  onDelete,
}: AutomationThreadScreenProps): JSX.Element {
  const [state, setState] = useState<AutomationThreadDataEx | 'loading' | 'error' | 'missing'>(
    'loading',
  );
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [sending, setSending] = useState(false);
  const [traces, setTraces] = useState<Record<string, AsstMsgDTO[]>>({});
  const [loadingTraces, setLoadingTraces] = useState<ReadonlySet<string>>(new Set());
  /** Turns whose cold trace read failed — distinct from "no messages yet". */
  const [traceErrors, setTraceErrors] = useState<ReadonlySet<string>>(new Set());
  /** Running turns whose live stream is gone and stayed gone after rejoins. */
  const [lostWatches, setLostWatches] = useState<ReadonlySet<string>>(new Set());
  const [pendingTrace, setPendingTrace] = useState<AsstMsgDTO[] | null>(null);
  const watchedTurnsRef = useRef(new Set<string>());
  const streamControllersRef = useRef(new Map<string, AbortController>());
  const [regenBusy, setRegenBusy] = useState(false);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  // The header's overflow menu (Edit / Pause-Resume / Delete). Closes on
  // Escape or an outside click — the document listeners are only attached
  // while it's open and torn down on close/unmount.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuWrapRef = useRef<HTMLDivElement | null>(null);

  const reload = useCallback(async () => {
    try {
      const d = await loadData();
      setState(d ?? 'missing');
    } catch {
      setState('error');
    }
  }, [loadData]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const loadTrace = useCallback(
    async (turnId: string): Promise<void> => {
      setLoadingTraces((current) => new Set(current).add(turnId));
      try {
        const messages = await loadTurnTrace(turnId);
        setTraces((current) => ({ ...current, [turnId]: messages }));
        setTraceErrors((current) => withoutId(current, turnId));
      } catch {
        // A failed cold read is NOT an empty turn. Writing `[]` here would be
        // indistinguishable from "no messages yet" — the turn would show the
        // spinner and the Done/Failed footer at once and lose "Show trace".
        // Leave `traces` untouched and flag the turn so it offers a retry.
        setTraceErrors((current) => new Set(current).add(turnId));
      } finally {
        setLoadingTraces((current) => withoutId(current, turnId));
      }
    },
    [loadTurnTrace],
  );

  /**
   * Join a running turn's live stream, rejoining with backoff when the join is
   * refused or the stream drops with the turn still open (the gateway's
   * subscriber cap answers 503; a restart or proxy idle timeout just closes
   * the socket). The old 2s poll this replaced is gone, so without a rejoin a
   * still-running turn would spin "Working through your instructions…" until
   * the reader navigated away and back. Bounded: after the last delay the turn
   * is marked lost and the reader gets an explicit Reconnect.
   */
  const watchNativeTurn = useCallback(
    (turnId: string): void => {
      if (watchedTurnsRef.current.has(turnId)) return;
      watchedTurnsRef.current.add(turnId);
      setLostWatches((current) => withoutId(current, turnId));
      const controller = new AbortController();
      streamControllersRef.current.set(turnId, controller);
      const pause = (ms: number): Promise<void> =>
        new Promise((resolve) => {
          const timer = window.setTimeout(resolve, ms);
          controller.signal.addEventListener(
            'abort',
            () => {
              window.clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      void (async () => {
        for (let attempt = 0; !controller.signal.aborted; attempt++) {
          let settled = false;
          try {
            settled = await watchTurn(
              turnId,
              (messages) => setTraces((current) => ({ ...current, [turnId]: messages })),
              controller.signal,
            );
          } catch {
            settled = false;
          }
          if (controller.signal.aborted) return;
          if (settled) {
            // `watchTurn` already performed the authoritative ledger re-read
            // and pushed its messages — only the header/run row needs a reload.
            await reload();
            return;
          }
          const delay = WATCH_REJOIN_DELAYS_MS[attempt];
          if (delay === undefined) {
            // Keep the id in `watchedTurnsRef` so the auto-watch effect does
            // not immediately restart the loop; `retryWatch` clears it.
            setLostWatches((current) => new Set(current).add(turnId));
            return;
          }
          await pause(delay);
        }
      })().finally(() => {
        // Only retire our own registration: `retryWatch` aborts this loop and
        // registers a replacement under the same turn id, and this `finally`
        // runs after that — deleting blindly would orphan the live stream.
        if (streamControllersRef.current.get(turnId) === controller) {
          streamControllersRef.current.delete(turnId);
        }
      });
    },
    [reload, watchTurn],
  );

  const retryWatch = useCallback(
    (turnId: string): void => {
      streamControllersRef.current.get(turnId)?.abort();
      watchedTurnsRef.current.delete(turnId);
      watchNativeTurn(turnId);
    },
    [watchNativeTurn],
  );

  // Latest history is warm; older turns stay collapsed until the reader asks
  // for their trace. If the latest turn is still open (including one fired by
  // an external trigger), join its event stream instead of polling.
  useEffect(() => {
    if (state === 'loading' || state === 'error' || state === 'missing') return;
    const latest = state.runs[0];
    if (!latest) return;
    if (
      traces[latest.runId] === undefined &&
      !loadingTraces.has(latest.runId) &&
      !traceErrors.has(latest.runId)
    ) {
      void loadTrace(latest.runId);
    }
    if (latest.status === 'running') watchNativeTurn(latest.runId);
  }, [loadTrace, loadingTraces, state, traceErrors, traces, watchNativeTurn]);

  useEffect(
    () => () => {
      for (const controller of streamControllersRef.current.values()) controller.abort();
      streamControllersRef.current.clear();
    },
    [],
  );

  // Dismiss the overflow menu on Escape or an outside click. Listeners live
  // only for the menu's open lifetime.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    const onClick = (e: MouseEvent): void => {
      if (!menuWrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [menuOpen]);

  if (state === 'loading' || state === 'error' || state === 'missing') {
    return (
      <div className={au.auLoading}>
        <div className={au.auCrumb}>
          <button type="button" onClick={onBack}>
            Automations
          </button>
          <span className={au.auCrumbSep} aria-hidden="true">
            <Icon name="ArrowRight" size={12} />
          </span>
          <span>
            {state === 'loading' ? 'Loading…' : state === 'missing' ? 'Not found' : 'Error'}
          </span>
        </div>
        <div className={styles.loadingBody}>
          {state === 'loading'
            ? 'Loading automation…'
            : state === 'missing'
              ? 'Automation not found.'
              : 'Could not load automation.'}
        </div>
      </div>
    );
  }

  const d = state;
  const { header, consent, runs } = d;

  const doDelete = (): void => {
    setBusy(true);
    void onDelete().then((deleted) => {
      if (!deleted) setBusy(false);
    });
  };
  const doRun = (): void => {
    setRunning(true);
    void onRunNow()
      .then((turnId) => {
        if (!turnId) return;
        const startedAt = Date.now();
        setState((current) => {
          if (current === 'loading' || current === 'error' || current === 'missing') return current;
          if (current.runs.some((run) => run.runId === turnId)) return current;
          return {
            ...current,
            runs: [
              {
                runId: turnId,
                status: 'running',
                originLabel: 'Manual',
                startedAt,
                endedAt: null,
                durationMs: null,
                summary: 'Working through your instructions…',
                costUsd: null,
                dateGroup: 'Today',
              },
              ...current.runs,
            ],
          };
        });
        setTraces((current) => ({ ...current, [turnId]: [] }));
        watchNativeTurn(turnId);
      })
      .finally(() => setRunning(false));
  };
  const doToggle = (next: boolean): void => {
    void onToggleEnabled(next).then((ok) => {
      if (ok) void reload();
    });
  };
  const doRegenerate = (): void => {
    setRegenBusy(true);
    void onRotateWebhook().finally(() => setRegenBusy(false));
  };
  const doDecide = (
    kind: ConsentKind,
    id: string,
    decision: ConsentDecision,
    alwaysAllow?: boolean,
  ): void => {
    setDecidingId(id);
    void onDecideConsent(kind, id, decision, alwaysAllow).then((ok) => {
      setDecidingId(null);
      if (ok) void reload();
    });
  };
  const doSend = (text: string, applyFuture: boolean): void => {
    setSending(true);
    setPendingTrace([
      { kind: 'user', text },
      { kind: 'ai', streaming: true, text: '' },
    ]);
    const controller = new AbortController();
    streamControllersRef.current.set('composer', controller);
    void onSendMessage(text, applyFuture, setPendingTrace, controller.signal)
      .then(async (turnId) => {
        if (!turnId || controller.signal.aborted) return;
        await reload();
        await loadTrace(turnId);
      })
      .catch(() => undefined)
      .finally(() => {
        streamControllersRef.current.delete('composer');
        setPendingTrace(null);
        setSending(false);
      });
  };

  const activeGrants = consent.grants.filter((g) => !g.revokedAt);
  const pendingOutbox = consent.outbox.filter((o) => o.status === 'pending');
  const hasPending = consent.parked.length > 0 || pendingOutbox.length > 0;
  const groups = groupRuns(runs);

  return (
    <div className={styles.screen} data-hue={header.hue} data-testid="automation-thread">
      <div className={styles.head}>
        <div className={styles.headMain}>
          <span className={au.auGlyph} data-hue={header.hue} data-size="lg">
            <Icon name={header.glyphIcon as IconName} size={22} />
          </span>
          <div className={styles.headText}>
            <h1>{header.name}</h1>
            {header.description ? <p className={styles.headSub}>{header.description}</p> : null}
            {header.entityTags.length > 0 ? (
              <div className={styles.chips} aria-label="Tagged data">
                {header.entityTags.map((tag) => (
                  <span key={`${tag.type}/${tag.id}`} className={styles.chip}>
                    <code>@{tag.type}</code>
                    <span>{tag.id}</span>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          {/* Header stays quiet in the happy path: the compile state already
              shows as its own turn in the thread (Compiling… / Plan ready /
              Compile failed → Retry button), and enable/disable lives in the
              ⋯ menu. Only "Paused" is worth a persistent header badge, since
              nothing else signals a stopped automation at a glance. */}
          {header.statusKind === 'paused' ? (
            <span
              className={au.auStatus}
              data-tone={header.statusKind}
              data-au-status={header.statusKind}
              role="status"
            >
              <span className={au.auStatusIc} aria-hidden="true">
                <Icon name={STATUS_ICON[header.statusKind]} size={12} />
              </span>
              <span>{header.statusLabel}</span>
            </span>
          ) : null}
          <div className={au.auActions}>
            {header.statusLabel === 'Compile failed' ? (
              <button
                type="button"
                className={cx(au.auBtn, au.auBtnGhost)}
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void onRetryCompile().finally(() => {
                    setBusy(false);
                    void reload();
                  });
                }}
              >
                <Icon name="Refresh" size={14} />
                <span>Retry compile</span>
              </button>
            ) : null}
            <button
              type="button"
              className={cx(au.auBtn, au.auBtnPrimary)}
              disabled={busy || running}
              onClick={doRun}
            >
              <Icon name="Play" size={14} />
              <span>{running ? 'Starting…' : 'Run now'}</span>
            </button>
            <div className={styles.menuWrap} ref={menuWrapRef}>
              <button
                type="button"
                className={styles.menuTrigger}
                data-testid="automation-menu-trigger"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label="More actions"
                disabled={busy}
                onClick={() => setMenuOpen((v) => !v)}
              >
                <Icon name="MoreHoriz" size={18} />
              </button>
              {menuOpen ? (
                <div className={styles.menu} role="menu">
                  <button
                    type="button"
                    className={styles.menuItem}
                    role="menuitem"
                    data-testid="automation-menu-edit"
                    onClick={() => {
                      setMenuOpen(false);
                      onEdit();
                    }}
                  >
                    <Icon name="Pencil" size={15} />
                    <span>Edit setup</span>
                  </button>
                  <button
                    type="button"
                    className={styles.menuItem}
                    role="menuitem"
                    data-testid="automation-menu-toggle"
                    onClick={() => {
                      setMenuOpen(false);
                      doToggle(!header.enabled);
                    }}
                  >
                    <Icon name={header.enabled ? 'Pause' : 'Play'} size={15} />
                    <span>{header.enabled ? 'Pause' : 'Resume'}</span>
                  </button>
                  <div className={styles.menuDivider} role="separator" />
                  <button
                    type="button"
                    className={cx(styles.menuItem, styles.menuItemDanger)}
                    role="menuitem"
                    data-testid="automation-menu-delete"
                    onClick={() => {
                      setMenuOpen(false);
                      doDelete();
                    }}
                  >
                    <Icon name="Trash" size={15} />
                    <span>Delete</span>
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
        <TriggerChips
          header={header}
          triggerDetail={d.triggerDetail}
          regenBusy={regenBusy}
          onCopyWebhook={onCopyWebhook}
          onRegenerate={doRegenerate}
        />
      </div>

      {hasPending ? (
        <div className={styles.consentStrip}>
          {consent.parked.map((item) => (
            <ParkedCard
              key={item.invocationId}
              item={item}
              busy={decidingId === item.invocationId}
              onDecide={(decision) => doDecide('parked', item.invocationId, decision)}
            />
          ))}
          {pendingOutbox.map((item) => (
            <OutboxCard
              key={item.itemId}
              item={item}
              busy={decidingId === item.itemId}
              onDecide={(decision, alwaysAllow) =>
                doDecide('outbox', item.itemId, decision, alwaysAllow)
              }
            />
          ))}
        </div>
      ) : null}
      {activeGrants.length > 0 ? (
        <GrantsLine
          grants={activeGrants}
          busyId={decidingId}
          onRevoke={(grantId) => doDecide('grant', grantId, 'revoke')}
        />
      ) : null}

      <div className={styles.thread}>
        {groups.length === 0 ? (
          <div className={styles.empty}>
            <span className={styles.emptyIcon} aria-hidden="true">
              <Icon name="Activity" size={22} />
            </span>
            <div className={styles.emptyTitle}>No runs yet</div>
            <p className={styles.emptyHint}>Run now, or wait for the trigger.</p>
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.dateGroup} className={styles.dateGroup}>
              <div className={styles.dateSep}>
                <span>{g.dateGroup}</span>
              </div>
              {g.runs.map((run) => (
                <RunTurn
                  key={run.runId}
                  run={run}
                  tokens={d.runTokens?.[run.runId]}
                  messages={traces[run.runId]}
                  traceLoading={loadingTraces.has(run.runId)}
                  traceFailed={traceErrors.has(run.runId)}
                  watchLost={lostWatches.has(run.runId)}
                  onLoadTrace={() => void loadTrace(run.runId)}
                  onRetryWatch={() => retryWatch(run.runId)}
                  rerunBusy={busy || running}
                  onOpen={() => onOpenRun(run.runId)}
                  onRerun={doRun}
                />
              ))}
            </div>
          ))
        )}
        {pendingTrace ? (
          <div className={styles.pendingConversation} data-testid="automation-pending-turn">
            {pendingTrace.map((message, index) => (
              <Message
                key={message.msgId ?? `${message.kind}:${index}`}
                m={message}
                index={index}
                cb={{
                  hydrateRefs: () => undefined,
                  wireCodeCopy: () => undefined,
                  loadAttachmentImage: () =>
                    Promise.reject(new Error('automation attachments unavailable')),
                  onCopyMessage: (text) => void navigator.clipboard?.writeText(text),
                  onFeedback: () => undefined,
                  onRegenerate: () => undefined,
                  onRetryError: () => undefined,
                  onPagerNav: () => undefined,
                }}
              />
            ))}
          </div>
        ) : null}
      </div>

      {d.automationTurns ? <Composer busy={sending} onSend={doSend} /> : null}
    </div>
  );
}
