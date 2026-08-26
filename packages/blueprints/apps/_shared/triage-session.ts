// TRIAGE SESSION (#712) — queue+cursor machine shared by Face Review (durable
// answers, queue re-read per write), Duplicate Review (ephemeral snapshot) and
// Docs OCR. Shared surface only: one current item, a FROZEN denominator,
// skip-vs-answer, per-outcome counts. Pure values, so native twins import it.

/** Immutable; `cursor === queue.length` means finished. */
export interface TriageSession<Item> {
  readonly queue: readonly Item[];
  readonly cursor: number;
  readonly total: number;
  readonly counts: Readonly<Record<string, number>>;
}

export interface TriageProgress {
  readonly position: number;
  readonly total: number;
  readonly answered: number;
  readonly remaining: number;
  readonly done: boolean;
}

/** Pass `total` when the queue is one page of a larger backlog. */
export function openTriage<Item>(
  queue: readonly Item[],
  options?: { total?: number; at?: number }
): TriageSession<Item> {
  return {
    queue,
    cursor: clampCursor(options?.at ?? 0, queue.length),
    total: options?.total ?? queue.length,
    counts: {},
  };
}

export function triageCurrent<Item>(
  session: TriageSession<Item>
): Item | undefined {
  return session.queue[session.cursor];
}

/** Records nothing and WRAPS: a skip leaves the item in the queue. */
export function triageSkip<Item>(
  session: TriageSession<Item>
): TriageSession<Item> {
  if (session.queue.length === 0) return session;
  return { ...session, cursor: (session.cursor + 1) % session.queue.length };
}

/** Advances; running off the end ends the session. */
export function triageAnswer<Item>(
  session: TriageSession<Item>,
  outcome: string
): TriageSession<Item> {
  return {
    ...session,
    cursor: session.cursor + 1,
    counts: {
      ...session.counts,
      [outcome]: (session.counts[outcome] ?? 0) + 1,
    },
  };
}

/** Keeps total and counts; indexes shifted, so the cursor returns to head. */
export function triageRefill<Item>(
  session: TriageSession<Item>,
  queue: readonly Item[],
  options?: { at?: number }
): TriageSession<Item> {
  return {
    ...session,
    queue,
    cursor: clampCursor(options?.at ?? 0, queue.length),
  };
}

export function triageProgress<Item>(
  session: TriageSession<Item>
): TriageProgress {
  const answered = Object.values(session.counts).reduce((sum, n) => sum + n, 0);
  const done = triageCurrent(session) === undefined;
  const total = Math.max(session.total, 1);
  return {
    position: Math.min(answered + 1, total),
    total,
    answered,
    remaining: Math.max(session.queue.length - session.cursor - 1, 0),
    done,
  };
}

function clampCursor(at: number, length: number): number {
  if (length === 0) return 0;
  return Number.isInteger(at) && at >= 0 && at < length ? at : 0;
}
