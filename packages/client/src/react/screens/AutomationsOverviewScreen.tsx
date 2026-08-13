import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import type {
  AuOverviewData,
  AuOverviewRowDTO,
  AuOverviewRunDTO,
  AuOverviewSuggestionDTO,
  AutomationsOverviewBridgeProps,
} from "../screen-contracts.js";
import type { OpsState } from "../shell/opsBar.js";
import { publishRouteSignals } from "../shell/routeVitals.js";
import { PageSkeleton } from "../shell/status.js";
import ChipsBlock from "../ui/ChipsBlock.js";
import EmptyBlock from "../ui/EmptyBlock.js";
import NoteBlock from "../ui/NoteBlock.js";
import PanelBlock from "../ui/PanelBlock.js";
import RowsBlock from "../ui/RowsBlock.js";
import type { RowDef } from "../ui/RowsBlock.js";
import SectionBlock from "../ui/SectionBlock.js";
import { sortOverviewRows } from "./automationsOverviewGrouping.js";

import styles from "./AutomationsOverviewScreen.module.css";

// Automations overview — the v9 operational page (issue #765, spec §3).
//
// The screen is a SEQUENCE OF BLOCKS and nothing else: section heads, row
// lists, a note. Its identity (title, the two verbs) lives in the app bar
// (`opsBar.ts`), and its condition lives in the frame's status line — both fed
// from here through `publishRouteSignals` at the one point the data resolves,
// so the count line and the health line can never disagree about state.
//
// What the tile grid used to say, and where it went:
//   glyph plate / hue        → gone. A hue per automation was decoration; the
//                              list answers "what needs me?" by ORDER and by
//                              the one net-toned row, not by colour.
//   status pill              → the row's meta word ("Active", "Failing").
//   attention badge          → a clause in the row's sub line, because a count
//                              of things waiting on you is a sentence, not a
//                              chip.
//   last-run blurb + foot    → the row's sub line.
//   date-grouped run feed    → one flat "recent runs across everything" list;
//                              each run states its own time in its sub.

/** Rows past this many make the page `full` — the state that earns a filter
 *  row. Below it the chips would be four controls over a list you can already
 *  see all of. */
const FULL_THRESHOLD = 8;

/** How many runs the "across everything" list shows. Beyond this the section
 *  stops being a glance and starts being a log; the run view is the log. */
const RECENT_CAP = 10;

type ChipId = "all" | "failing" | "paused" | "drafts";

const CHIP_LABEL: Record<ChipId, string> = {
  all: "All",
  drafts: "Drafts",
  failing: "Failing",
  paused: "Paused",
};

const CHIP_ORDER: readonly ChipId[] = ["all", "failing", "paused", "drafts"];

/** The empty state, verbatim (spec §3 `opsDef`). An automation is a trigger
 *  and a thing to do — the copy says exactly that rather than apologising for
 *  the absence. */
const EMPTY_TITLE = "Nothing runs on its own yet";
const EMPTY_BODY =
  "An automation is a trigger and a thing to do. Start from a template, or describe what you want and the assistant will draft one.";
const EMPTY_ACTION = "Browse templates";

/** The error state, verbatim (spec §3): what failed, what is still safe, one
 *  way forward. The "nothing has run since <time>" clause is dropped when this
 *  screen has never had a successful read to take the time from — an invented
 *  clock is worse than a shorter sentence. */
const ERROR_TITLE = "The scheduler is not answering";
const ERROR_RETRY = "Reconnect";

function errorBody(sinceClock: string | null): string {
  return sinceClock === null
    ? "Automations are stored on the gateway and are safe. Nothing has been lost — runs queue until the scheduler is back."
    : `Automations are stored on the gateway and are safe. Nothing has run since ${sinceClock} and nothing has been lost — runs queue until the scheduler is back.`;
}

const LOADING_NOTE =
  "A row knows its shape before its content arrives, so nothing reflows when it does.";

/**
 * The suggestions note.
 *
 * The v9 brief's sentence is "Suggestions come from what you already do by
 * hand." That is not true of this product: `loadOverviewSuggestions`
 * (templatesData.ts) returns a curated slice of the TEMPLATE CATALOGUE, keyed
 * off a fixed id list — nothing watches what you do by hand and nothing infers
 * a rule from it. The second half of the sentence is true and load-bearing, so
 * it stands verbatim; the provenance half states the provenance this product
 * actually has. See the receipt for the mismatch.
 */
const SUGGESTIONS_NOTE =
  "Suggestions come from the template catalogue, not from watching you. They are never created for you.";

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** "4 August" — the day a failure streak began. Day and month only: a year on
 *  a run that failed this week reads as an archive entry. */
function dayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
  });
}

/** "09:12" — the clock the error panel's "nothing has run since" clause takes. */
function clockLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface FailureStreak {
  /** How many runs in a row failed, newest-first, before the first success. */
  count: number;
  /** When the streak started — the OLDEST failure in it. */
  startedAt: number;
}

/**
 * The unbroken run of failures at the head of an automation's history.
 *
 * Counted from the newest run backwards and stopped at the first success,
 * which is what makes "has failed its last 3 runs" a true sentence rather than
 * a total. `null` when the automation's newest run succeeded, or when the feed
 * carries no run for it at all (the window is 100 runs per lane — a quiet
 * automation can fall off the end of it).
 */
function failureStreak(
  ref: string,
  runs: readonly AuOverviewRunDTO[]
): FailureStreak | null {
  let count = 0;
  let startedAt = 0;
  for (const run of runs) {
    if (run.automationId !== ref) continue;
    if (run.ok) break;
    count += 1;
    startedAt = run.startedAt;
  }
  return count === 0 ? null : { count, startedAt };
}

/** The row's second line: what fires it, then how it last went. */
function rowSub(
  row: AuOverviewRowDTO,
  streak: FailureStreak | null
): string | undefined {
  const parts = [row.triggerLabel];
  if (streak)
    parts.push(
      `failed ${plural(streak.count, "run")} in a row, since ${dayLabel(streak.startedAt)}`
    );
  else if (row.lastRunOk === false) parts.push("last run failed");
  else parts.push(row.lastRunLabel);
  if (row.attentionCount > 0)
    parts.push(`${plural(row.attentionCount, "item")} waiting on you`);
  if (row.recentFailover) parts.push("ran on a fallback harness");
  return parts.filter((part) => part.length > 0).join(" · ");
}

interface OverviewView {
  memberRows: AuOverviewRowDTO[];
  visibleRows: AuOverviewRowDTO[];
  recognitionRows: AuOverviewRowDTO[];
  runs: AuOverviewRunDTO[];
  recognitionRuns: AuOverviewRunDTO[];
  failing: AuOverviewRowDTO[];
  streakByRef: Map<string, FailureStreak | null>;
  countLine: string;
  healthLabel: string;
  healthDetail: string;
  /** The automation the status line's one inline verb opens. */
  failureRef: string | null;
  /** The newest run's clock, kept for the error panel's "since" clause. */
  lastRunClock: string | null;
  empty: boolean;
  full: boolean;
}

/** Everything the render and the published signals both need, derived once so
 *  the count line and the status line cannot be computed from two different
 *  readings of the same data. */
function deriveView(data: AuOverviewData, chip: ChipId): OverviewView {
  const memberRows = sortOverviewRows(
    data.rows.filter((row) => row.systemLane === undefined)
  );
  const recognitionRows = sortOverviewRows(
    data.rows.filter((row) => row.systemLane === "recognition")
  );
  const runs = data.runs
    .filter((run) => run.systemLane === undefined)
    .slice(0, RECENT_CAP);
  const recognitionRuns = data.runs
    .filter((run) => run.systemLane === "recognition")
    .slice(0, RECENT_CAP);

  const streakByRef = new Map<string, FailureStreak | null>(
    memberRows.map((row) => [
      row.ref,
      failureStreak(
        row.ref,
        data.runs.filter((run) => run.systemLane === undefined)
      ),
    ])
  );
  const failing = memberRows.filter((row) => row.lastRunOk === false);
  const paused = memberRows.filter((row) => row.statusKind === "paused");
  const drafts = memberRows.filter((row) => row.statusKind === "draft");

  const visibleRows =
    chip === "failing"
      ? failing
      : chip === "paused"
        ? paused
        : chip === "drafts"
          ? drafts
          : memberRows;

  // The worst failure leads the status line: the longest streak, because "has
  // failed its last 6 runs" is a different problem from "failed once".
  const worst = [...failing].sort((a, b) => {
    const aStreak = streakByRef.get(a.ref)?.count ?? 1;
    const bStreak = streakByRef.get(b.ref)?.count ?? 1;
    return bStreak - aStreak;
  })[0];
  const worstStreak = worst ? streakByRef.get(worst.ref) : null;

  const newestRun = data.runs[0];
  return {
    countLine: [
      plural(memberRows.length, "automation"),
      `${failing.length} failing`,
      `${paused.length} paused`,
    ].join(" · "),
    empty: memberRows.length === 0,
    failing,
    failureRef: worst?.ref ?? null,
    full: memberRows.length >= FULL_THRESHOLD,
    healthDetail: worst
      ? worstStreak
        ? `${worst.name} has failed its last ${plural(worstStreak.count, "run")}, since ${dayLabel(worstStreak.startedAt)}.`
        : `${worst.name} failed its last run.`
      : newestRun
        ? `${plural(memberRows.length, "automation")} on this gateway · last run ${newestRun.whenLabel}.`
        : `${plural(memberRows.length, "automation")} on this gateway · nothing has run yet.`,
    healthLabel:
      failing.length > 0
        ? `${plural(failing.length, "automation")} failing`
        : "Nothing is failing",
    lastRunClock: newestRun ? clockLabel(newestRun.startedAt) : null,
    memberRows,
    recognitionRows,
    recognitionRuns,
    runs,
    streakByRef,
    visibleRows,
  };
}

export default function AutomationsOverviewScreen({
  loadData,
  loadSuggestions,
  onOpenAutomation,
  onOpenRun,
  onBrowseTemplates,
  onUseSuggestion,
}: AutomationsOverviewBridgeProps): JSX.Element {
  const [state, setState] = useState<AuOverviewData | "loading" | "error">(
    "loading"
  );
  const [errMsg, setErrMsg] = useState("");
  const [chip, setChip] = useState<ChipId>("all");
  const [lastReadAt, setLastReadAt] = useState<number | null>(null);
  // Survives the transition INTO the error state: the panel's "nothing has run
  // since 09:12" clause is about the last reading that worked, so it cannot
  // come from the data the screen no longer has.
  const [lastRunClock, setLastRunClock] = useState<string | null>(null);

  // Keep the latest loadData without rebinding reload. Routes historically pass
  // an inline async prop; if reload depended on that identity, every parent
  // re-render remounted the load effect, thrashing the error/Retry UI (desktop
  // e2e 8.2).
  const loadDataRef = useRef(loadData);
  useEffect(() => {
    loadDataRef.current = loadData;
  }, [loadData]);

  const load = useCallback(
    (): Promise<void> =>
      loadDataRef
        .current()
        .then((data) => {
          setState(data);
          setLastReadAt(Date.now());
          const newest = data.runs[0];
          if (newest) setLastRunClock(clockLabel(newest.startedAt));
        })
        .catch((error: unknown) => {
          setErrMsg(error instanceof Error ? error.message : String(error));
          setState("error");
        }),
    []
  );

  /** The Reconnect affordance — the only path that puts the screen back into
   *  `loading`; the mount read starts there already. */
  const reload = useCallback((): void => {
    setState("loading");
    void load();
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  // With no suggestion loader there are no suggestions — derived, not synced,
  // so no effect has to blank the list out.
  const [fetchedSuggestions, setFetchedSuggestions] = useState<
    AuOverviewSuggestionDTO[]
  >([]);
  const suggestions = loadSuggestions ? fetchedSuggestions : [];

  useEffect(() => {
    if (!loadSuggestions) return;
    let cancelled = false;
    void loadSuggestions()
      .then((rows) => {
        if (!cancelled) setFetchedSuggestions(rows);
      })
      .catch(() => {
        if (!cancelled) setFetchedSuggestions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [loadSuggestions]);

  const view = typeof state === "object" ? deriveView(state, chip) : null;
  const opsState: OpsState =
    state === "loading"
      ? "loading"
      : state === "error"
        ? "error"
        : view?.empty === true
          ? "empty"
          : view?.full === true
            ? "full"
            : "ready";

  // The inline verb opens an automation that may have changed identity since
  // the effect last ran; the handler is read through a ref so the published
  // signal's deps stay primitive and the frame is not re-signalled on every
  // parent render.
  const openRef = useRef(onOpenAutomation);
  useEffect(() => {
    openRef.current = onOpenAutomation;
  }, [onOpenAutomation]);

  const countLine = view?.countLine ?? "";
  const healthLabel = view?.healthLabel ?? "";
  const healthDetail = view?.healthDetail ?? "";
  const failureRef = view?.failureRef ?? null;
  useEffect(() => {
    publishRouteSignals("automations", {
      count: countLine,
      state: opsState,
      ...(lastReadAt === null ? {} : { lastReadAt }),
      ...(healthLabel
        ? {
            health: {
              detail: healthDetail,
              label: healthLabel,
              ...(failureRef
                ? {
                    action: {
                      label: "Open the failure",
                      run: () => openRef.current(failureRef),
                    },
                  }
                : {}),
            },
          }
        : {}),
      ...(failureRef ? { tone: "net" as const } : {}),
    });
  }, [countLine, opsState, lastReadAt, healthLabel, healthDetail, failureRef]);

  if (state === "loading") {
    return (
      <div className={styles.page} data-testid="automations-loading">
        <PageSkeleton label="Loading automations" rows={6} />
        <NoteBlock>{LOADING_NOTE}</NoteBlock>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className={styles.page} data-testid="automations-error">
        <PanelBlock
          action={{ label: ERROR_RETRY, onClick: reload }}
          body={errorBody(lastRunClock)}
          eyebrow="Automations"
          {...(errMsg ? { facts: [{ key: "Reason", value: errMsg }] } : {})}
          title={ERROR_TITLE}
          tone="net"
        />
      </div>
    );
  }

  // `view` is non-null on every path past the two early returns above: it is
  // derived from the same `state` those branches eliminated.
  const v = view as OverviewView;

  const automationRows: RowDef[] = v.visibleRows.map((row) => {
    const streak = v.streakByRef.get(row.ref) ?? null;
    const failing = row.lastRunOk === false;
    const sub = rowSub(row, streak);
    return {
      action: {
        label: "Open",
        onClick: () => onOpenAutomation(row.ref),
        // The one thing that distinguishes ten identical "Open" controls. It
        // is a hint and not an `aria-label` because the button already renders
        // visible text (aria-label discipline, issue #708 B.4); the shell
        // lowers it to `title`, the phone to `accessibilityHint`.
        hint: `Open ${row.name}`,
      },
      id: row.ref,
      meta: failing ? "Failing" : row.statusLabel,
      net: failing,
      ...(sub ? { sub } : {}),
      title: row.name,
    };
  });

  const runRows = (runs: readonly AuOverviewRunDTO[]): RowDef[] =>
    runs.map((run) => ({
      action: {
        label: "View",
        onClick: () => onOpenRun(run.automationId, run.runId),
        hint: `View the ${run.name} run from ${run.whenLabel}`,
      },
      id: run.runId,
      meta: run.ok ? run.whenLabel : "Failed",
      net: !run.ok,
      sub: `${run.ok ? "Succeeded" : "Failed"} · ${run.summary} · ${run.whenLabel}`,
      title: run.name,
    }));

  const suggestionRows: RowDef[] = onUseSuggestion
    ? suggestions.map((suggestion) => ({
        action: {
          label: "Create",
          onClick: () => onUseSuggestion(suggestion.id),
          hint: `Create ${suggestion.name}`,
        },
        id: suggestion.id,
        sub: suggestion.triggerLabel
          ? `${suggestion.desc} · ${suggestion.triggerLabel}`
          : suggestion.desc,
        title: suggestion.name,
      }))
    : [];

  return (
    <div className={styles.page} data-testid="automations-overview">
      {v.empty ? (
        <EmptyBlock
          action={{ label: EMPTY_ACTION, onClick: onBrowseTemplates }}
          body={EMPTY_BODY}
          routine
          title={EMPTY_TITLE}
        />
      ) : (
        <>
          {v.full ? (
            <ChipsBlock
              ariaLabel="Filter automations"
              chips={CHIP_ORDER.map((id) => ({
                id,
                label: CHIP_LABEL[id],
                on: chip === id,
              }))}
              onPick={(id) => setChip(id as ChipId)}
            />
          ) : null}
          <SectionBlock
            label="Automations"
            meta={
              v.visibleRows.length === v.memberRows.length
                ? String(v.memberRows.length)
                : `${v.visibleRows.length} of ${v.memberRows.length}`
            }
          />
          {automationRows.length > 0 ? (
            <RowsBlock ariaLabel="Automations" rows={automationRows} />
          ) : (
            <NoteBlock>
              {`No automation is ${CHIP_LABEL[chip].toLowerCase()} right now.`}
            </NoteBlock>
          )}

          <SectionBlock
            label="Recent runs across everything"
            meta={String(v.runs.length)}
          />
          {v.runs.length > 0 ? (
            <RowsBlock ariaLabel="Recent runs" rows={runRows(v.runs)} />
          ) : (
            <NoteBlock>
              Nothing has run yet. Open an automation and run it once, or wait
              for its trigger.
            </NoteBlock>
          )}
        </>
      )}

      {suggestionRows.length > 0 ? (
        <>
          <SectionBlock
            label="Worth setting up"
            meta={String(suggestionRows.length)}
          />
          <RowsBlock ariaLabel="Worth setting up" rows={suggestionRows} />
          <NoteBlock>{SUGGESTIONS_NOTE}</NoteBlock>
        </>
      ) : null}

      {v.recognitionRows.length > 0 ? (
        <>
          <SectionBlock
            label="Recognition"
            meta={`${v.recognitionRows.length} built-in`}
          />
          <RowsBlock
            ariaLabel="Recognition recipes"
            rows={v.recognitionRows.map((row) => ({
              action: {
                label: "Open",
                onClick: () => onOpenAutomation(row.ref),
                hint: `Open ${row.name}`,
              },
              id: row.ref,
              meta: row.statusLabel,
              sub: `${row.triggerLabel} · ${row.lastRunLabel}`,
              title: row.name,
            }))}
          />
        </>
      ) : null}

      {v.recognitionRuns.length > 0 ? (
        <>
          <SectionBlock
            label="Recognition history"
            meta={String(v.recognitionRuns.length)}
          />
          <RowsBlock
            ariaLabel="Recognition history"
            rows={runRows(v.recognitionRuns)}
          />
        </>
      ) : null}
    </div>
  );
}
