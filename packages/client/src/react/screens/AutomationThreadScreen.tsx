// governance: allow-repo-hygiene file-size-limit (#539) single cohesive screen component (header/consent-strip/chat-turn spine/steering composer of one thread surface); splitting would fragment one visual unit
import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, JSX, SetStateAction } from "react";

import type { IconName } from "@centraid/design";

import { formatBytes } from "../../format.js";
import type {
  AsstModelPickerDTO,
  AsstMsgDTO,
  AuPlanStatusDTO,
  AuStatusKind,
  AutomationThreadBridgeProps,
  AutomationThreadData,
  BuilderAttachmentRef,
  ConsentDecision,
  ConsentKind,
  GrantDTO,
  OutboxItemDTO,
  ParkedItemDTO,
  ThreadRunDTO,
} from "../screen-contracts.js";
import { cx } from "../ui/cx.js";
import { Icon } from "../ui/index.js";
import Message from "./AssistantMessage.js";
import type { MessageCallbacks } from "./AssistantMessage.js";
import { EffortPicker, ModelPicker, RunnerPicker } from "./AssistantScreen.js";
import ChatComposer from "./ChatComposer.js";

import au from "../styles/automation.module.css";
import styles from "./AutomationThreadScreen.module.css";

// The RUN SCREEN — one of the two automation surfaces, and the one that
// changes nothing.
//
// It answers exactly two questions: what has this automation DONE, and what
// can you tell me about it. Every fire is a turn on a flight-recorder spine
// (oldest→newest, date-grouped); the run summary is the message, telemetry
// sits in a quiet footer, a failed run speaks as an error, and the composer
// asks questions ABOUT those runs.
//
// What deliberately is NOT here, and why:
//   - compile turns: they are the compiler's working, not executions. They
//     used to sit in this list as "Compile" cards among real runs.
//   - "Retry compile": compiling is the compiler's job; the plan banner links
//     there instead of doing it from here.
//   - "Apply to future runs": a reply that silently rewrote the standing
//     instructions was authoring performed from the reading surface. The
//     composer is read-only now, and the rewrite path lives in the compiler.
// Anything the reader wants to CHANGE resolves to one call: `onOpenCompiler`.
//
// Purely presentational: the route wrapper (`AutomationViewRoute.tsx`) owns
// IO, confirm dialogs, toasts, and navigation.

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
    conditionDetail: {
      entity: string;
      everyLabel: string | null;
      whereText: string;
    } | null;
  };
  runTokens?: Record<string, number>;
  /** Capability-backed attended runner controls for the Q&A conversation. */
  runnerConfig?: AsstModelPickerDTO;
}

export interface AutomationThreadScreenProps extends Omit<
  AutomationThreadBridgeProps,
  "loadData"
> {
  loadData: () => Promise<AutomationThreadDataEx | null>;
}

const STATUS_ICON: Record<AuStatusKind, IconName> = {
  active: "Power",
  paused: "Pause",
  draft: "Pencil",
  running: "Loader",
  success: "CheckCircle",
  failed: "AlertTriangle",
};

/**
 * Backoff between rejoin attempts for a dropped/refused turn stream. Bounded
 * on purpose: four quick tries cover a gateway restart or a momentarily full
 * subscriber cap, and anything longer is a real outage the reader should be
 * told about rather than a spinner that never resolves.
 */
const WATCH_REJOIN_DELAYS_MS = [500, 1500, 4000, 10_000];

function withoutId(
  current: ReadonlySet<string>,
  id: string
): ReadonlySet<string> {
  if (!current.has(id)) return current;
  const next = new Set(current);
  next.delete(id);
  return next;
}

function pauseWatchRejoin(
  controller: AbortController,
  ms: number
): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, ms);
    controller.signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

async function watchNativeTurnWithBackoff(
  turnId: string,
  controller: AbortController,
  io: {
    watchTurn: AutomationThreadBridgeProps["watchTurn"];
    reload: () => Promise<void>;
    setTraces: Dispatch<SetStateAction<Record<string, AsstMsgDTO[]>>>;
    setLostWatches: Dispatch<SetStateAction<ReadonlySet<string>>>;
  },
  attempt = 0
): Promise<void> {
  if (controller.signal.aborted) return;
  let settled = false;
  try {
    settled = await io.watchTurn(
      turnId,
      (messages) =>
        io.setTraces((current) => ({ ...current, [turnId]: messages })),
      controller.signal
    );
  } catch {
    settled = false;
  }
  if (controller.signal.aborted) return;
  if (settled) {
    await io.reload();
    return;
  }
  const delay = WATCH_REJOIN_DELAYS_MS[attempt];
  if (delay === undefined) {
    io.setLostWatches((current) => new Set(current).add(turnId));
    return;
  }
  await pauseWatchRejoin(controller, delay);
  return watchNativeTurnWithBackoff(turnId, controller, io, attempt + 1);
}

/**
 * Cold-read one turn's trace, marking it in-flight first so the effect that
 * warms the latest turn cannot start a second read for the same turn.
 *
 * Module scope, taking its setters as arguments: this is an IO routine, not a
 * render value, and the in-flight mark HAS to land before the read starts.
 */
function fetchTurnTrace(
  turnId: string,
  io: {
    loadTurnTrace: (turnId: string) => Promise<AsstMsgDTO[]>;
    setTraces: Dispatch<SetStateAction<Record<string, AsstMsgDTO[]>>>;
    setTraceErrors: Dispatch<SetStateAction<ReadonlySet<string>>>;
    setLoadingTraces: Dispatch<SetStateAction<ReadonlySet<string>>>;
  }
): Promise<void> {
  const { loadTurnTrace, setTraces, setTraceErrors, setLoadingTraces } = io;
  setLoadingTraces((current) => new Set(current).add(turnId));
  return loadTurnTrace(turnId)
    .then(
      (messages) => {
        setTraces((current) => ({ ...current, [turnId]: messages }));
        setTraceErrors((current) => withoutId(current, turnId));
      },
      () => {
        // A failed cold read is NOT an empty turn. Writing `[]` here would be
        // indistinguishable from "no messages yet" — the turn would show the
        // spinner and the Done/Failed footer at once and lose "Show trace".
        // Leave `traces` untouched and flag the turn so it offers a retry.
        setTraceErrors((current) => new Set(current).add(turnId));
      }
    )
    .finally(() => {
      setLoadingTraces((current) => withoutId(current, turnId));
    });
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
  if (mins < 1) return "just now";
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
  header: AutomationThreadData["header"];
  triggerDetail: AutomationThreadDataEx["triggerDetail"];
  regenBusy: boolean;
  onCopyWebhook: (url: string) => void;
  onRegenerate: () => void;
}): JSX.Element {
  const cronExprs = triggerDetail?.cronExprs ?? [];
  const dataDetail = triggerDetail?.dataDetail ?? null;
  const conditionDetail = triggerDetail?.conditionDetail ?? null;
  const hasStructured =
    cronExprs.length > 0 ||
    !!header.webhook ||
    !!dataDetail ||
    !!conditionDetail;
  const triggerKind =
    cronExprs.length > 0
      ? "cron"
      : header.webhook
        ? "webhook"
        : dataDetail
          ? "data"
          : conditionDetail
            ? "condition"
            : "manual";

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
            <code
              className={styles.chipUrl}
              data-testid="automation-webhook-url"
            >
              {header.webhook.url}
            </code>
            <button
              type="button"
              className={styles.chipIconBtn}
              aria-label="Copy webhook URL"
              title="Copy webhook URL"
              onClick={() =>
                header.webhook?.url && onCopyWebhook(header.webhook.url)
              }
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
            watches <code>{dataDetail.entities.join(", ")}</code>
            {dataDetail.everyLabel
              ? ` · ${dataDetail.everyLabel.toLowerCase()}`
              : ""}
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
            {conditionDetail.everyLabel
              ? ` · ${conditionDetail.everyLabel.toLowerCase()}`
              : ""}
          </span>
        </span>
      ) : null}
      {hasStructured ? null : (
        <span className={styles.chip}>{header.triggerSummary}</span>
      )}
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
          onClick={() => onDecide("discard")}
        >
          Dismiss
        </button>
        <button
          type="button"
          className={cx(au.auBtn, au.auBtnPrimary, styles.consentBtnSm)}
          disabled={busy}
          onClick={() => onDecide("approve")}
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
  const pending = item.status === "pending";
  return (
    <div
      className={styles.consentCard}
      data-kind="outbox"
      data-status={item.status}
    >
      <span className={styles.consentIc} aria-hidden="true">
        <Icon name="Send" size={14} />
      </span>
      <div className={styles.consentBody}>
        <div className={styles.consentTitle}>
          Staged: {item.verb} {item.connectionLabel} to{" "}
          <code>{item.target}</code>
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
            onClick={() => onDecide("discard")}
          >
            Reject
          </button>
          <button
            type="button"
            className={cx(au.auBtn, au.auBtnPrimary, styles.consentBtnSm)}
            disabled={busy}
            onClick={() => onDecide("approve", alwaysAllow)}
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
        {grants.length} standing grant{grants.length === 1 ? "" : "s"}
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
  if (run.status === "running") return "Loader";
  if (run.status === "fail") return "AlertTriangle";
  // An ask is the reader's own question sitting in the history — it must not
  // wear an execution's trigger glyph.
  if (run.entryKind === "ask") return "Send";
  const origin = run.originLabel.toLowerCase();
  if (origin.includes("manual")) return "Play";
  if (origin.includes("webhook")) return "Webhook";
  if (origin.includes("data") || origin.includes("watch")) return "Folder";
  if (origin.includes("replay")) return "Refresh";
  return "Clock";
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
  loadAttachmentImage,
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
  loadAttachmentImage?: (hash: string, mime: string) => Promise<string>;
}): JSX.Element {
  const time = new Date(run.startedAt).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const running = run.status === "running";
  const failed = run.status === "fail";
  const hasTrace = messages !== undefined;
  // "Run again" re-fires the automation. Offering it on an ask would re-run
  // the automation in answer to a question — never what the reader meant.
  const rerunnable = run.entryKind === "run";
  const messageCallbacks: MessageCallbacks = {
    hydrateRefs: () => undefined,
    wireCodeCopy: () => undefined,
    loadAttachmentImage:
      loadAttachmentImage ??
      (() => Promise.reject(new Error("automation attachments unavailable"))),
    onCopyMessage: (text) => void navigator.clipboard?.writeText(text),
    onFeedback: () => undefined,
    onRegenerate: () => undefined,
    onRetryError: () => undefined,
    onPagerNav: () => undefined,
  };
  return (
    <article
      className={styles.turn}
      data-run-status={run.status}
      data-entry-kind={run.entryKind}
      data-testid={run.entryKind === "ask" ? "ask-entry" : "run-entry"}
    >
      <span
        className={styles.node}
        data-run-status={run.status}
        data-spin={running ? "true" : undefined}
        aria-hidden="true"
      >
        <Icon name={nodeIconFor(run)} size={12} />
      </span>
      <div className={styles.turnHead}>
        <span className={styles.turnOrigin}>{run.originLabel}</span>
        <span className={styles.turnTime}>{time}</span>
        <span className={styles.turnHeadSpacer} />
        {!running && rerunnable ? (
          <button
            type="button"
            className={styles.turnRerun}
            disabled={rerunBusy}
            onClick={onRerun}
          >
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
            {rerunnable ? (
              <button
                type="button"
                className={cx(au.auBtn, au.auBtnPrimary, styles.turnErrorBtn)}
                disabled={rerunBusy}
                onClick={onRerun}
              >
                Try again
              </button>
            ) : null}
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
              {run.durationMs === null ? null : (
                <span>{fmtDuration(run.durationMs)}</span>
              )}
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
              <span>{traceLoading ? "Loading…" : "Show trace"}</span>
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
          <div className={styles.turnErrorBody}>
            Couldn’t load this turn’s transcript.
          </div>
          <div className={styles.turnErrorActions}>
            <button
              type="button"
              className={cx(au.auBtn, au.auBtnGhost, styles.turnErrorBtn)}
              data-testid="retry-trace"
              disabled={traceLoading}
              onClick={onLoadTrace}
            >
              {traceLoading ? "Retrying…" : "Try again"}
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
          <span
            className={styles.turnOutcome}
            data-ok={failed ? undefined : "true"}
          >
            <Icon name={failed ? "AlertTriangle" : "CheckCircle"} size={13} />
            <span>{failed ? "Failed" : "Done"}</span>
          </span>
          <span className={styles.turnTelem}>
            {run.durationMs === null ? null : (
              <span>{fmtDuration(run.durationMs)}</span>
            )}
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

/**
 * The plan banner — the ONLY thing the run screen says about compilation, and
 * it says it without offering to do anything about it.
 *
 * A `ready` plan is silent: a working automation should not carry a status
 * bar. Compiling, failed, and never-compiled each explain what that means for
 * the runs below, and hand off to the compiler. This replaced a "Retry
 * compile" button that let you kick the compiler from the surface that has no
 * way to show you whether it worked.
 */
function PlanBanner({
  plan,
  onOpenCompiler,
}: {
  plan: AuPlanStatusDTO;
  onOpenCompiler: () => void;
}): JSX.Element | null {
  if (plan.state === "ready") return null;
  return (
    <div
      className={styles.planBanner}
      data-state={plan.state}
      data-testid="plan-banner"
    >
      <span
        className={styles.planIc}
        aria-hidden="true"
        data-spin={plan.state === "compiling"}
      >
        <Icon
          name={
            plan.state === "compiling"
              ? "Loader"
              : plan.state === "failed"
                ? "AlertTriangle"
                : "Braces"
          }
          size={14}
        />
      </span>
      <div className={styles.planBody}>
        <div className={styles.planTitle}>{plan.label}</div>
        {plan.detail ? (
          <p className={styles.planDetail}>{plan.detail}</p>
        ) : null}
      </div>
      {plan.state === "compiling" ? null : (
        <button
          type="button"
          className={cx(au.auBtn, au.auBtnGhost, styles.planBtn)}
          data-testid="plan-open-compiler"
          onClick={onOpenCompiler}
        >
          <span>Open compiler</span>
          <Icon name="ArrowRight" size={13} />
        </button>
      )}
    </div>
  );
}

/**
 * The question composer. Read-only by construction: it asks about the runs
 * above and never writes to the automation. The hint line is load-bearing —
 * it tells a reader who arrived wanting to change something exactly where to
 * go, which is the affordance the old "Apply to future runs" toggle was
 * standing in for.
 */
function Composer({
  busy,
  onSend,
  onStop,
  onOpenCompiler,
  picker,
  context,
  onUploadAttachment,
  onSetRunner,
  onRunnerSwitch,
}: {
  busy: boolean;
  onSend: (
    text: string,
    options: {
      attachments?: BuilderAttachmentRef[];
      runnerKind?: string;
      model?: string;
      thinking?: string;
    }
  ) => void;
  onStop: () => void;
  onOpenCompiler: () => void;
  picker?: AsstModelPickerDTO;
  context?: { used: number; size: number };
  onUploadAttachment?: (file: File) => Promise<BuilderAttachmentRef>;
  onSetRunner?: (runnerKind: string) => Promise<AsstModelPickerDTO>;
  onRunnerSwitch?: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState("");
  const [pickerOverride, setPickerOverride] = useState<
    AsstModelPickerDTO | undefined
  >(undefined);
  const [pickerLoaded, setPickerLoaded] = useState(true);
  const [pending, setPending] = useState<
    Array<{
      localId: string;
      filename: string;
      sizeBytes: number;
      state: "uploading" | "ready" | "error";
      ref?: BuilderAttachmentRef;
    }>
  >([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activePicker = pickerOverride ?? picker;
  const trimmed = draft.trim();
  const ready = pending.flatMap((attachment) =>
    attachment.state === "ready" && attachment.ref ? [attachment.ref] : []
  );
  const submit = (): void => {
    if (!trimmed && ready.length === 0) return;
    if (pending.some((attachment) => attachment.state === "uploading")) return;
    onSend(trimmed, {
      ...(ready.length ? { attachments: ready } : {}),
      ...(activePicker?.selectedRunnerKind
        ? { runnerKind: activePicker.selectedRunnerKind }
        : {}),
      ...(activePicker?.selectedModelId
        ? { model: activePicker.selectedModelId }
        : {}),
      ...(activePicker?.selectedEffortId
        ? { thinking: activePicker.selectedEffortId }
        : {}),
    });
    setDraft("");
    setPending([]);
  };
  const attachFiles = (files: File[]): void => {
    if (!onUploadAttachment) return;
    for (const file of files) {
      const localId = crypto.randomUUID();
      setPending((current) => [
        ...current,
        {
          localId,
          filename: file.name,
          sizeBytes: file.size,
          state: "uploading",
        },
      ]);
      void onUploadAttachment(file).then(
        (ref) =>
          setPending((current) =>
            current.map((attachment) =>
              attachment.localId === localId
                ? { ...attachment, state: "ready", ref }
                : attachment
            )
          ),
        () =>
          setPending((current) =>
            current.map((attachment) =>
              attachment.localId === localId
                ? { ...attachment, state: "error" }
                : attachment
            )
          )
      );
    }
  };
  const selectRunner = (runnerKind: string): void => {
    const setRunner = onSetRunner;
    if (!setRunner) return;
    setPickerLoaded(false);
    void (async () => {
      try {
        const next = await setRunner(runnerKind);
        const changed =
          next.selectedRunnerKind === runnerKind &&
          activePicker?.selectedRunnerKind !== next.selectedRunnerKind;
        setPickerOverride(next);
        if (changed) onRunnerSwitch?.();
        if (!next.supportsAttachments) setPending([]);
      } finally {
        setPickerLoaded(true);
      }
    })();
  };
  return (
    <div className={styles.composerWrap}>
      <ChatComposer
        value={draft}
        onChange={setDraft}
        onSend={submit}
        onStop={onStop}
        busy={busy}
        canSend={
          (Boolean(trimmed) || ready.length > 0) &&
          !pending.some((attachment) => attachment.state === "uploading")
        }
        placeholder="Ask about these runs — what failed, what changed, why…"
        ariaLabel="Ask about this automation's runs"
        context={activePicker?.supportsContext ? context : undefined}
        above={
          pending.length ? (
            <div className={styles.attachRow}>
              {pending.map((attachment) => (
                <div
                  key={attachment.localId}
                  className={styles.attachChip}
                  data-state={attachment.state}
                >
                  <span>{attachment.filename}</span>
                  <span>
                    {attachment.state === "uploading"
                      ? "…"
                      : formatBytes(attachment.sizeBytes)}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${attachment.filename}`}
                    onClick={() =>
                      setPending((current) =>
                        current.filter(
                          (entry) => entry.localId !== attachment.localId
                        )
                      )
                    }
                  >
                    <Icon name="X" size={10} />
                  </button>
                </div>
              ))}
            </div>
          ) : null
        }
        leading={
          activePicker?.supportsAttachments && onUploadAttachment ? (
            <>
              <button
                type="button"
                className={styles.attachButton}
                aria-label="Attach files"
                onClick={() => fileInputRef.current?.click()}
              >
                <Icon name="Paperclip" size={15} />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  if (files.length) attachFiles(files);
                  event.target.value = "";
                }}
              />
            </>
          ) : undefined
        }
        model={
          activePicker ? (
            <>
              <RunnerPicker
                picker={activePicker}
                loaded={pickerLoaded}
                busy={busy}
                onSelect={selectRunner}
              />
              <ModelPicker
                picker={activePicker}
                loaded={pickerLoaded}
                busy={busy}
                onSelect={(model) =>
                  setPickerOverride(
                    activePicker
                      ? { ...activePicker, selectedModelId: model }
                      : undefined
                  )
                }
              />
            </>
          ) : undefined
        }
        effort={
          activePicker ? (
            <EffortPicker
              picker={activePicker}
              loaded={pickerLoaded}
              busy={busy}
              onSelect={(effort) =>
                setPickerOverride(
                  activePicker
                    ? { ...activePicker, selectedEffortId: effort }
                    : undefined
                )
              }
            />
          ) : undefined
        }
        hint={
          <>
            Answers only — nothing here changes the automation. Switching agents
            uses a bounded handoff and may ask for provider consent.{" "}
            <button
              type="button"
              className={styles.composerLink}
              onClick={onOpenCompiler}
            >
              Open the compiler
            </button>{" "}
            to change what it does.
          </>
        }
      />
    </div>
  );
}

export default function AutomationThreadScreen({
  loadData,
  loadTurnTrace,
  watchTurn,
  onBack,
  onOpenCompiler,
  onOpenRun,
  onRunNow,
  onToggleEnabled,
  onDecideConsent,
  onAskAboutRuns,
  onUploadAttachment,
  loadAttachmentImage,
  onSetRunner,
  onCopyWebhook,
  onRotateWebhook,
  onDelete,
}: AutomationThreadScreenProps): JSX.Element {
  const [state, setState] = useState<
    AutomationThreadDataEx | "loading" | "error" | "missing"
  >("loading");
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [sending, setSending] = useState(false);
  const [traces, setTraces] = useState<Record<string, AsstMsgDTO[]>>({});
  const [loadingTraces, setLoadingTraces] = useState<ReadonlySet<string>>(
    new Set()
  );
  /** Turns whose cold trace read failed — distinct from "no messages yet". */
  const [traceErrors, setTraceErrors] = useState<ReadonlySet<string>>(
    new Set()
  );
  /** Running turns whose live stream is gone and stayed gone after rejoins. */
  const [lostWatches, setLostWatches] = useState<ReadonlySet<string>>(
    new Set()
  );
  const [pendingTrace, setPendingTrace] = useState<AsstMsgDTO[] | null>(null);
  const [composerContext, setComposerContext] = useState<{
    used: number;
    size: number;
  }>();
  const watchedTurnsRef = useRef(new Set<string>());
  const streamControllersRef = useRef(new Map<string, AbortController>());
  const [regenBusy, setRegenBusy] = useState(false);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  // The header's overflow menu (Edit / Pause-Resume / Delete). Closes on
  // Escape or an outside click — the document listeners are only attached
  // while it's open and torn down on close/unmount.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuWrapRef = useRef<HTMLDivElement | null>(null);

  const reload = useCallback(
    (): Promise<void> =>
      loadData()
        .then((d) => setState(d ?? "missing"))
        .catch(() => setState("error")),
    [loadData]
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  const loadTrace = useCallback(
    (turnId: string): Promise<void> =>
      fetchTurnTrace(turnId, {
        loadTurnTrace,
        setLoadingTraces,
        setTraceErrors,
        setTraces,
      }),
    [loadTurnTrace]
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
      void watchNativeTurnWithBackoff(turnId, controller, {
        watchTurn,
        reload,
        setTraces,
        setLostWatches,
      }).finally(() => {
        // Only retire our own registration: `retryWatch` aborts this loop and
        // registers a replacement under the same turn id, and this `finally`
        // runs after that — deleting blindly would orphan the live stream.
        if (streamControllersRef.current.get(turnId) === controller) {
          streamControllersRef.current.delete(turnId);
        }
      });
    },
    [reload, watchTurn]
  );

  const retryWatch = useCallback(
    (turnId: string): void => {
      streamControllersRef.current.get(turnId)?.abort();
      watchedTurnsRef.current.delete(turnId);
      watchNativeTurn(turnId);
    },
    [watchNativeTurn]
  );

  // Latest history is warm; older turns stay collapsed until the reader asks
  // for their trace. If the latest turn is still open (including one fired by
  // an external trigger), join its event stream instead of polling.
  useEffect(() => {
    if (state === "loading" || state === "error" || state === "missing") return;
    const latest = state.runs[0];
    if (!latest) return;
    if (
      traces[latest.runId] === undefined &&
      !loadingTraces.has(latest.runId) &&
      !traceErrors.has(latest.runId)
    ) {
      void loadTrace(latest.runId);
    }
    if (latest.status === "running") watchNativeTurn(latest.runId);
  }, [loadTrace, loadingTraces, state, traceErrors, traces, watchNativeTurn]);

  useEffect(
    () => () => {
      for (const controller of streamControllersRef.current.values())
        controller.abort();
      streamControllersRef.current.clear();
    },
    []
  );

  // Dismiss the overflow menu on Escape or an outside click. Listeners live
  // only for the menu's open lifetime.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    const onClick = (e: MouseEvent): void => {
      if (!menuWrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [menuOpen]);

  if (state === "loading" || state === "error" || state === "missing") {
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
            {state === "loading"
              ? "Loading…"
              : state === "missing"
                ? "Not found"
                : "Error"}
          </span>
        </div>
        <div className={styles.loadingBody}>
          {state === "loading"
            ? "Loading automation…"
            : state === "missing"
              ? "Automation not found."
              : "Could not load automation."}
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
          if (
            current === "loading" ||
            current === "error" ||
            current === "missing"
          )
            return current;
          if (current.runs.some((run) => run.runId === turnId)) return current;
          return {
            ...current,
            runs: [
              {
                runId: turnId,
                entryKind: "run",
                status: "running",
                originLabel: "Manual",
                startedAt,
                endedAt: null,
                durationMs: null,
                summary: "Working through your instructions…",
                costUsd: null,
                dateGroup: "Today",
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
    alwaysAllow?: boolean
  ): void => {
    setDecidingId(id);
    void onDecideConsent(kind, id, decision, alwaysAllow).then((ok) => {
      setDecidingId(null);
      if (ok) void reload();
    });
  };
  const doSend = (
    text: string,
    options: {
      attachments?: BuilderAttachmentRef[];
      runnerKind?: string;
      model?: string;
      thinking?: string;
    }
  ): void => {
    setSending(true);
    setPendingTrace([
      {
        kind: "user",
        text,
        ...(options.attachments?.length
          ? {
              attachments: options.attachments.map((attachment) => ({
                ...attachment,
                filename: attachment.filename ?? "attachment",
              })),
            }
          : {}),
      },
      { kind: "ai", streaming: true, text: "" },
    ]);
    const controller = new AbortController();
    streamControllersRef.current.set("composer", controller);
    void onAskAboutRuns(
      text,
      {
        ...options,
        onContext: setComposerContext,
      },
      setPendingTrace,
      controller.signal
    )
      .then(async (turnId) => {
        if (!turnId || controller.signal.aborted) return;
        await reload();
        await loadTrace(turnId);
      })
      .catch(() => undefined)
      .finally(() => {
        streamControllersRef.current.delete("composer");
        setPendingTrace(null);
        setSending(false);
      });
  };

  const activeGrants = consent.grants.filter((g) => !g.revokedAt);
  const pendingOutbox = consent.outbox.filter((o) => o.status === "pending");
  const hasPending = consent.parked.length > 0 || pendingOutbox.length > 0;
  const groups = groupRuns(runs);

  return (
    <div
      className={styles.screen}
      data-hue={header.hue}
      data-testid="automation-thread"
    >
      <div className={styles.head}>
        <div className={styles.headMain}>
          <span className={au.auGlyph} data-hue={header.hue} data-size="lg">
            <Icon name={header.glyphIcon as IconName} size={22} />
          </span>
          <div className={styles.headText}>
            <h1>{header.name}</h1>
            {header.description ? (
              <p className={styles.headSub}>{header.description}</p>
            ) : null}
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
          {/* Header stays quiet in the happy path: compile state lives in the
              plan banner below (and its remedies live in the compiler), and
              enable/disable is in the ⋯ menu. Only "Paused" earns a persistent
              header badge, since nothing else signals a stopped automation at
              a glance. */}
          {header.statusKind === "paused" ? (
            <output
              className={au.auStatus}
              data-tone={header.statusKind}
              data-au-status={header.statusKind}
            >
              <span className={au.auStatusIc} aria-hidden="true">
                <Icon name={STATUS_ICON[header.statusKind]} size={12} />
              </span>
              <span>{header.statusLabel}</span>
            </output>
          ) : null}
          <div className={cx(au.auActions, styles.headActions)}>
            <button
              type="button"
              className={cx(au.auBtn, au.auBtnGhost)}
              data-testid="open-compiler"
              onClick={onOpenCompiler}
              title="Edit and recompile this automation"
            >
              <Icon name="Braces" size={14} />
              <span>Compiler</span>
            </button>
            <button
              type="button"
              className={cx(au.auBtn, au.auBtnPrimary)}
              disabled={busy || running}
              onClick={doRun}
            >
              <Icon name="Play" size={14} />
              <span>{running ? "Starting…" : "Run now"}</span>
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
                      onOpenCompiler();
                    }}
                  >
                    <Icon name="Pencil" size={15} />
                    <span>Edit &amp; compile</span>
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
                    <Icon name={header.enabled ? "Pause" : "Play"} size={15} />
                    <span>{header.enabled ? "Pause" : "Resume"}</span>
                  </button>
                  <hr className={styles.menuDivider} />
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

      <PlanBanner plan={d.plan} onOpenCompiler={onOpenCompiler} />

      {hasPending ? (
        <div className={styles.consentStrip}>
          {consent.parked.map((item) => (
            <ParkedCard
              key={item.invocationId}
              item={item}
              busy={decidingId === item.invocationId}
              onDecide={(decision) =>
                doDecide("parked", item.invocationId, decision)
              }
            />
          ))}
          {pendingOutbox.map((item) => (
            <OutboxCard
              key={item.itemId}
              item={item}
              busy={decidingId === item.itemId}
              onDecide={(decision, alwaysAllow) =>
                doDecide("outbox", item.itemId, decision, alwaysAllow)
              }
            />
          ))}
        </div>
      ) : null}
      {activeGrants.length > 0 ? (
        <GrantsLine
          grants={activeGrants}
          busyId={decidingId}
          onRevoke={(grantId) => doDecide("grant", grantId, "revoke")}
        />
      ) : null}

      <div className={styles.thread}>
        {groups.length === 0 ? (
          <div className={styles.empty}>
            <span className={styles.emptyIcon} aria-hidden="true">
              <Icon name="Activity" size={22} />
            </span>
            <div className={styles.emptyTitle}>No runs yet</div>
            <p className={styles.emptyHint}>
              {d.plan.state === "ready"
                ? "Run now, or wait for the trigger."
                : "Nothing has run yet — this automation needs a working plan first."}
            </p>
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
                  loadAttachmentImage={loadAttachmentImage}
                />
              ))}
            </div>
          ))
        )}
        {pendingTrace ? (
          <div
            className={styles.pendingConversation}
            data-testid="automation-pending-turn"
          >
            {pendingTrace.map((message, index) => (
              <Message
                key={message.msgId ?? `${message.kind}:${index}`}
                m={message}
                index={index}
                cb={{
                  hydrateRefs: () => undefined,
                  wireCodeCopy: () => undefined,
                  loadAttachmentImage:
                    loadAttachmentImage ??
                    (() =>
                      Promise.reject(
                        new Error("automation attachments unavailable")
                      )),
                  onCopyMessage: (text) =>
                    void navigator.clipboard?.writeText(text),
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

      {d.automationTurns ? (
        <Composer
          busy={sending}
          onSend={doSend}
          onStop={() => streamControllersRef.current.get("composer")?.abort()}
          onOpenCompiler={onOpenCompiler}
          picker={d.runnerConfig}
          context={composerContext}
          onUploadAttachment={onUploadAttachment}
          onSetRunner={onSetRunner}
          onRunnerSwitch={() => setComposerContext(undefined)}
        />
      ) : null}
    </div>
  );
}
