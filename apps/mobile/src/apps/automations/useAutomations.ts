// The Automations place's data half (#765): one list read, a fan-out over the
// run log, the template catalogue, and the two writes this surface owns —
// nothing about layout or copy.
//
// WHY THE FAN-OUT. The reference's page opens with "recent runs across
// everything", and the failing rows it net-tones are failing because of what
// their RUNS did. This gateway serves runs per automation
// (`GET /_automations/turns?ref=…`) and offers no vault-wide feed, so the page
// reads a bounded window of each automation's turns and merges them newest
// first. The bounds are stated (`RUN_FANOUT`, `RUNS_PER_AUTOMATION`) and the
// model is told WHICH refs were read (`known`), so an automation outside the
// window is never described as one that has never run.
//
// A turns read that fails degrades to "no runs for this automation" rather
// than failing the page: the list itself is the page, and a run log that did
// not answer costs a clause in a sub line, not the screen.
//
// Both writes re-read afterwards rather than patching a row in place — the
// same rule `useConnectors` follows. A row that says `Active` because this
// screen assumed so is exactly the lie the page exists to prevent.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { OpsState } from "../../kit/components/health-line";
import { postStatus } from "../../kit/components/status-line";
import {
  cloneAutomationTemplate,
  listAutomationTemplates,
  listAutomations,
  listAutomationTurns,
  setAutomationEnabled,
} from "../../lib/automations";
import type { AutomationRow, AutomationTemplate } from "../../lib/automations";
import { resolveGatewayBase } from "../../lib/gateway";
import { clockLabel, opsStateFor } from "./automations-model";
import type { AutomationFilter, RunEntry } from "./automations-model";

/** How many automations the page reads runs for. A vault holds a handful; the
 *  cap exists so a pathological one cannot turn opening a list into fifty
 *  round trips on a phone connection. */
const RUN_FANOUT = 12;
/** How deep each automation's window goes. Enough to count a failure streak
 *  and to place the automation in the recent feed, not a log. */
const RUNS_PER_AUTOMATION = 5;
/** How many runs the "across everything" section shows. Beyond this it stops
 *  being a glance and starts being a log; the thread is the log. */
export const RECENT_CAP = 10;

/** What the gateway answered. `empty`/`full` are derived, never stored. */
export type AutomationsLoad =
  | { kind: "loading" }
  /** `at` is when the answer landed. Every relative phrase on the page is
   *  measured from it rather than from a clock read during render. */
  | {
      at: number;
      kind: "ready";
      rows: AutomationRow[];
      runs: RunEntry[];
      known: Set<string>;
    }
  /** `reason` is the underlying failure, shown as the error panel's one fact;
   *  `unpaired` is the calm degrade (no gateway linked yet), which takes the
   *  same panel with the sentence that is true of it. */
  | { kind: "error"; reason: string; unpaired: boolean };

export interface AutomationsController {
  load: AutomationsLoad;
  state: OpsState;
  rows: readonly AutomationRow[];
  runs: readonly RunEntry[];
  known: ReadonlySet<string>;
  /** The clock every relative phrase on the page is measured from. */
  now: number;
  filter: AutomationFilter;
  setFilter: (next: AutomationFilter) => void;
  templates: readonly AutomationTemplate[];
  /** The template whose `Create` is in flight, if any. */
  installing: string | undefined;
  refreshing: boolean;
  actionError: string | undefined;
  /** The last clock this screen ever read successfully — the error panel's
   *  "nothing has run since" clause, which is about the reading that worked
   *  and so cannot come from data the screen no longer has. */
  lastRunClock: string | undefined;
  refresh: () => Promise<void>;
  retry: () => void;
  /** Enable or disable one automation, then re-read. */
  setEnabled: (ref: string, next: boolean) => void;
  /** Publish one template into this vault, then re-read. */
  install: (template: AutomationTemplate) => void;
}

/** One shared empty set, so a non-ready render does not mint a new identity
 *  every pass. */
const EMPTY_KNOWN: ReadonlySet<string> = new Set<string>();

const NOT_PAIRED =
  "Not linked to a gateway yet — pair this phone from Settings.";

function describe(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "The gateway did not answer.";
}

/** One automation's window of turns, joined to its name. An unanswered read is
 *  an empty window, not a failure — see the file header. */
async function runsOf(row: AutomationRow): Promise<RunEntry[]> {
  try {
    const turns = await listAutomationTurns(row.ref, RUNS_PER_AUTOMATION);
    return turns.map((turn) => ({
      detail: turn.ok ? (turn.summary ?? "") : (turn.error ?? ""),
      key: turn.turnId,
      name: row.name,
      ok: turn.ok,
      ref: row.ref,
      startedAt: turn.startedAt,
    }));
  } catch {
    return [];
  }
}

async function read(apply: (next: AutomationsLoad) => void): Promise<void> {
  try {
    if (!(await resolveGatewayBase())) {
      apply({ kind: "error", reason: NOT_PAIRED, unpaired: true });
      return;
    }
    const rows = await listAutomations();
    const reached = rows.slice(0, RUN_FANOUT);
    const windows = await Promise.all(reached.map(runsOf));
    const runs = windows.flat().sort((a, b) => b.startedAt - a.startedAt);
    apply({
      at: Date.now(),
      known: new Set(reached.map((row) => row.ref)),
      kind: "ready",
      rows,
      runs,
    });
  } catch (error) {
    apply({ kind: "error", reason: describe(error), unpaired: false });
  }
}

export function useAutomations(): AutomationsController {
  const [load, setLoad] = useState<AutomationsLoad>({ kind: "loading" });
  const [filter, setFilter] = useState<AutomationFilter>("all");
  const [templates, setTemplates] = useState<AutomationTemplate[]>([]);
  const [installing, setInstalling] = useState<string | undefined>();
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>();
  const [lastRunClock, setLastRunClock] = useState<string | undefined>();
  // A ref, not state: the guard has to hold WITHIN a tick. Two taps on the
  // same verb before React re-renders would otherwise send two writes for one
  // intent.
  const inFlight = useRef(false);

  const apply = useCallback((next: AutomationsLoad): void => {
    setLoad(next);
    if (next.kind !== "ready") return;
    const newest = next.runs[0];
    // Survives the transition INTO the error state: the panel's "nothing has
    // run since 09:12" clause is about the last reading that worked.
    if (newest) setLastRunClock(clockLabel(newest.startedAt));
  }, []);

  useEffect(() => {
    void read(apply);
  }, [apply]);

  // The catalogue is a second, independent read: it is not what the page is
  // about, and a gateway that cannot serve templates still has automations to
  // show. Its failure is an empty list, never the page's error state.
  useEffect(() => {
    let cancelled = false;
    void listAutomationTemplates()
      .then((rows) => {
        if (!cancelled) setTemplates(rows);
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    setActionError(undefined);
    await read(apply);
    setRefreshing(false);
  }, [apply]);

  const retry = useCallback((): void => {
    setLoad({ kind: "loading" });
    setActionError(undefined);
    void read(apply);
  }, [apply]);

  const setEnabled = useCallback(
    (ref: string, next: boolean): void => {
      if (inFlight.current) return;
      inFlight.current = true;
      void (async (): Promise<void> => {
        setActionError(undefined);
        try {
          await setAutomationEnabled(ref, next);
          await read(apply);
        } catch (error) {
          setActionError(describe(error));
        } finally {
          inFlight.current = false;
        }
      })();
    },
    [apply]
  );

  const install = useCallback(
    (template: AutomationTemplate): void => {
      if (installing !== undefined) return;
      setInstalling(template.id);
      void (async (): Promise<void> => {
        setActionError(undefined);
        try {
          await cloneAutomationTemplate(template.id);
          await read(apply);
          postStatus(`${template.name} is ready to use.`);
        } catch (error) {
          setActionError(describe(error));
        } finally {
          setInstalling(undefined);
        }
      })();
    },
    [apply, installing]
  );

  const rows = load.kind === "ready" ? load.rows : [];
  const runs = load.kind === "ready" ? load.runs : [];
  const known: ReadonlySet<string> =
    load.kind === "ready" ? load.known : EMPTY_KNOWN;
  // Nothing that is not `ready` shows a time, so the epoch is a fine stand-in
  // — and it keeps the clock out of the render path entirely.
  const now = load.kind === "ready" ? load.at : 0;
  const state = useMemo(
    () => opsStateFor(load.kind === "ready" ? "ready" : load.kind, rows.length),
    [load.kind, rows.length]
  );

  return {
    actionError,
    filter,
    install,
    installing,
    known,
    lastRunClock,
    load,
    now,
    refresh,
    refreshing,
    retry,
    rows,
    runs,
    setEnabled,
    setFilter,
    state,
    templates,
  };
}
