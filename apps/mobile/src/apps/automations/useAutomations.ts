// The Automations place's data half (#765).
//
// WHY THE FAN-OUT. The gateway serves runs per automation only, so the page
// reads a capped window of each and merges newest first; `known` names the
// refs actually read, so an automation outside the window is never described
// as never having run. A failed turns read is an empty window, not a failed
// page; both writes re-read rather than patching a row in place.

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

const RUN_FANOUT = 12;
const RUNS_PER_AUTOMATION = 5;
export const RECENT_CAP = 10;

export type AutomationsLoad =
  | { kind: "loading" }
  /** `at` is when the answer landed; relative phrases measure from it. */
  | {
      at: number;
      kind: "ready";
      rows: AutomationRow[];
      runs: RunEntry[];
      known: Set<string>;
    }
  | { kind: "error"; reason: string; unpaired: boolean };

export interface AutomationsController {
  load: AutomationsLoad;
  state: OpsState;
  rows: readonly AutomationRow[];
  runs: readonly RunEntry[];
  known: ReadonlySet<string>;
  now: number;
  filter: AutomationFilter;
  setFilter: (next: AutomationFilter) => void;
  templates: readonly AutomationTemplate[];
  installing: string | undefined;
  refreshing: boolean;
  actionError: string | undefined;
  /** Last clock read successfully — survives into the error state. */
  lastRunClock: string | undefined;
  refresh: () => Promise<void>;
  retry: () => void;
  setEnabled: (ref: string, next: boolean) => void;
  install: (template: AutomationTemplate) => void;
}

const EMPTY_KNOWN: ReadonlySet<string> = new Set<string>();

const NOT_PAIRED =
  "Not linked to a gateway yet — pair this phone from Settings.";

function describe(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "The gateway did not answer.";
}

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
  // A ref, not state: the guard must hold WITHIN a tick, before React re-renders.
  const inFlight = useRef(false);

  const apply = useCallback((next: AutomationsLoad): void => {
    setLoad(next);
    if (next.kind !== "ready") return;
    const newest = next.runs[0];
    if (newest) setLastRunClock(clockLabel(newest.startedAt));
  }, []);

  useEffect(() => {
    void read(apply);
  }, [apply]);

  // Independent read: a catalogue failure is an empty list, never the page's
  // error state.
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
