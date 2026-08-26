import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import {
  AUTOMATIONS_EMPTY_ACTION,
  AUTOMATIONS_EMPTY_BODY,
  AUTOMATIONS_EMPTY_TITLE,
  automationsErrorBody,
  AUTOMATIONS_ERROR_RETRY,
  AUTOMATIONS_ERROR_TITLE,
  AUTOMATIONS_SUGGESTIONS_NOTE,
} from "../../automations-copy.js";
import { SKELETON_NOTE } from "../../surface-copy.js";
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

// Automations overview (#765, spec §3). The screen is a SEQUENCE OF BLOCKS:
// section heads, row lists, a note. Its identity (title, the two verbs) lives
// in the app bar (`opsBar.ts`) and its condition in the frame's status line,
// both fed from here through `publishRouteSignals` at the one point the data
// resolves — so the count line and the health line cannot disagree.

/** Past this the page is `full` and earns its chips. */
const FULL_THRESHOLD = 8;

const RECENT_CAP = 10;

type ChipId = "all" | "failing" | "paused" | "drafts";

const CHIP_LABEL: Record<ChipId, string> = {
  all: "All",
  drafts: "Drafts",
  failing: "Failing",
  paused: "Paused",
};

const CHIP_ORDER: readonly ChipId[] = ["all", "failing", "paused", "drafts"];

// Same words mobile's Automations screen says, so they live in shared copy (#805).
const EMPTY_TITLE = AUTOMATIONS_EMPTY_TITLE;
const EMPTY_BODY = AUTOMATIONS_EMPTY_BODY;
const EMPTY_ACTION = AUTOMATIONS_EMPTY_ACTION;
const ERROR_TITLE = AUTOMATIONS_ERROR_TITLE;
const ERROR_RETRY = AUTOMATIONS_ERROR_RETRY;

function errorBody(sinceClock: string | null): string {
  return automationsErrorBody(sinceClock ?? undefined);
}

const LOADING_NOTE = SKELETON_NOTE;

/** Suggestions are a curated slice of the TEMPLATE CATALOGUE — nothing watches
 *  what a member does by hand, and the note must not claim otherwise. */
const SUGGESTIONS_NOTE = AUTOMATIONS_SUGGESTIONS_NOTE;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Day and month only: a year reads as an archive entry. */
function dayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
  });
}

function clockLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface FailureStreak {
  count: number;
  /** The OLDEST failure in the streak. */
  startedAt: number;
}

/** Newest run backwards, stopped at the first success — that is what makes
 *  "failed its last 3 runs" true rather than a total. `null` when the newest
 *  run succeeded or the 100-run lane window carries none. */
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
  failureRef: string | null;
  /** Kept for the error panel's "since" clause. */
  lastRunClock: string | null;
  empty: boolean;
  full: boolean;
}

/** Derived once, so render and published signals cannot read the data twice. */
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

  // Longest streak leads: "failed its last 6 runs" is a different problem.
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
  // Survives the transition INTO the error state: the panel's "since" clause is
  // about the last reading that worked.
  const [lastRunClock, setLastRunClock] = useState<string | null>(null);

  // Routes pass an inline async prop: depending on its identity would remount
  // the load effect on every parent render and thrash the Retry UI.
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

  /** The only path back into `loading`; the mount read starts there. */
  const reload = useCallback((): void => {
    setState("loading");
    void load();
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  // Derived, not synced: no effect has to blank the list out.
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

  // Read through a ref so the published signal's deps stay primitive and the
  // frame is not re-signalled on every parent render.
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

  // Non-null past the two early returns: derived from the `state` they eliminate.
  const v = view as OverviewView;

  const automationRows: RowDef[] = v.visibleRows.map((row) => {
    const streak = v.streakByRef.get(row.ref) ?? null;
    const failing = row.lastRunOk === false;
    const sub = rowSub(row, streak);
    return {
      action: {
        label: "Open",
        onClick: () => onOpenAutomation(row.ref),
        // A hint, not an `aria-label`: the button already renders visible text
        // (aria-label discipline, #708 B.4).
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
            <NoteBlock>Nothing has run yet.</NoteBlock>
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
