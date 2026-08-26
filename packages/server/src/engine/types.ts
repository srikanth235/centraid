export type AppId = string;

/**
 * Persisted in `<appsDir>/_registry.json`: code in the git store, app data in
 * the vault (#286).
 */
export interface RegistryEntry {
  id: AppId;
  path: string;
  registeredAt: string;
}

/** Shape exported by `queries/<id>.js`. Default export only. */
export interface QueryModule {
  default: HandlerFn<QueryHandlerArgs, unknown>;
}

/** Shape exported by `actions/<id>.js`. Default export only. */
export interface ActionModule {
  default: HandlerFn<ActionHandlerArgs, ActionResult>;
}

export type HandlerFn<Args, Ret = void> = (args: Args) => Promise<Ret>;

/**
 * Public handler type aliases. `ScopedVault` calls round-trip through the
 * worker boundary to the parent process — always await them.
 */
export type QueryHandler = HandlerFn<QueryHandlerArgs, unknown>;
export type ActionHandler = HandlerFn<ActionHandlerArgs, ActionResult>;

export interface ScopedVault {
  read: (request: Record<string, unknown>) => Promise<unknown>;
  search: (request: Record<string, unknown>) => Promise<unknown>;
  invoke: (request: Record<string, unknown>) => Promise<unknown>;
  query: (view: string, purpose: string) => Promise<unknown>;
  describe: () => Promise<unknown>;
  parked: () => Promise<unknown>;
  resolve: (request: Record<string, unknown>) => Promise<unknown>;
}

export interface ScopedLog {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export type ScopedFetch = (
  input: string,
  init?: RequestInit
) => Promise<Response>;

export interface AppRef {
  readonly id: AppId;
  readonly dir: string;
}

export interface ScopedRecurrenceInstance {
  readonly originalStart: string;
  readonly start: string;
  readonly wallStart: string;
  readonly overlap: boolean;
}

export interface ScopedRecurrenceException {
  readonly originalStart: string;
  readonly scope?: "occurrence" | "future";
  readonly action: "skip" | "override";
  readonly start?: string;
}

export interface ScopedTime {
  expandRecurrence: (input: {
    rrule: string;
    start: string;
    rangeFrom: string;
    rangeTo: string;
    timeZone?: string;
    semantics?: "zoned" | "floating" | "all-day";
    maxInstances?: number;
  }) => ScopedRecurrenceInstance[];
  applyRecurrenceExceptions: (
    instances: readonly ScopedRecurrenceInstance[],
    exceptions: readonly ScopedRecurrenceException[]
  ) => ScopedRecurrenceInstance[];
  /** The one member-facing recurrence summary; apps never render a raw rule. */
  describeRecurrence: (rrule: string) => string | null;
  collapseMissedOccurrences: (input: {
    rrule: string;
    scheduledStart: string;
    timeZone?: string;
    anchor?: "scheduled" | "completion";
    now: string;
    lastCompletedAt?: string;
  }) => { missed: number; nextDue: string | null };
  shiftTemporal: (value: string, deltaMs: number) => string;
}

export interface CommonHandlerArgs {
  log: ScopedLog;
  app: AppRef;
  ctx: {
    fetch: ScopedFetch;
    abortSignal: AbortSignal;
    vault: ScopedVault;
    time: ScopedTime;
  };
}

export interface QueryHandlerArgs extends CommonHandlerArgs {
  query: Record<string, string>;
  params: Record<string, string>;
}

export interface ActionHandlerArgs extends CommonHandlerArgs {
  body: unknown;
  params: Record<string, string>;
}

export interface ActionResult {
  status?: number;
  body?: unknown;
}
