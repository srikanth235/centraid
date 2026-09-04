import type { GatewayAuth } from "../gateway-auth.js";
import {
  ReplicaProtocolError,
  ReplicaRebootstrapRequiredError,
} from "./errors.js";
import {
  DEFAULT_REPLICA_BOOTSTRAP_WINDOW,
  fetchReplicaBootstrapPage,
  ReplicaTransportError,
} from "./shell-transport.js";
import type {
  ReplicaBootstrapFirstPage,
  ReplicaBootstrapPage,
  ReplicaFetcher,
} from "./shell-transport.js";
import type {
  ReplicaBootstrapAdvance,
  ReplicaBootstrapResume,
} from "./store-core.js";
import type {
  IntentOutcome,
  ReplicaBootstrapHeader,
  ReplicaChangeBatch,
  ReplicaCursor,
} from "./types.js";

/** Coordinator surface this driver needs — structural so tests can fake it. */
export interface WindowedBootstrapTarget {
  bootstrapBegin: (
    header: ReplicaBootstrapHeader,
    options?: { restart?: boolean }
  ) => Promise<ReplicaBootstrapResume | undefined>;
  bootstrapPage: (
    rows: ReplicaBootstrapPage["rows"],
    advance?: ReplicaBootstrapAdvance
  ) => Promise<void>;
  bootstrapPreview?: (cursor: ReplicaCursor) => Promise<void>;
  bootstrapCommit: (
    cursor: ReplicaCursor,
    header: ReplicaBootstrapHeader,
    outcomes?: IntentOutcome[]
  ) => Promise<ReplicaCursor>;
  applyChanges: (batch: ReplicaChangeBatch) => Promise<ReplicaCursor>;
}

export interface RunWindowedBootstrapOptions {
  gatewayAuth: GatewayAuth;
  target: WindowedBootstrapTarget;
  fetcher?: ReplicaFetcher;
  /** Rows per page; the gateway bounds this to 1..20000. */
  window?: number;
  signal?: AbortSignal;
  reconcileOutcomes?: (cursor: ReplicaCursor) => Promise<IntentOutcome[]>;
  pullChanges: (
    cursor: ReplicaCursor,
    signal: AbortSignal
  ) => Promise<ReplicaChangeBatch>;
  /** Guards against a pathological server that never stops emitting pages. */
  maxPages?: number;
  /** Guards the post-commit convergence replay; see {@link DEFAULT_MAX_CONVERGE_PASSES}. */
  maxConvergePasses?: number;
  onFirstPage?: (
    cursor: ReplicaCursor,
    header: ReplicaBootstrapHeader
  ) => void | Promise<void>;
  onProgress?: (pages: number) => void;
}

const DEFAULT_MAX_PAGES = 10_000;

/**
 * Convergence budget. Each pass applies one change batch and MUST advance the
 * cursor to earn another, so this is 1,000 batches of real, committed work —
 * a gateway log outrunning a phone, not a spin. See {@link converge} for why
 * stopping there is safe.
 */
const DEFAULT_MAX_CONVERGE_PASSES = 1_000;

/**
 * Drive a windowed bootstrap to a converged replica. Pages come from their
 * OWN snapshots (not a consistent cut); the repair is structural — commit at
 * the PAGE-1 cursor and replay the change log from it, idempotently. Skipping
 * the replay would leak deletions forever.
 *
 * The walk is RESUMABLE across process death (#880): the store keeps the
 * continuation token and the page-one cursor next to the rows of the page they
 * describe, so a bootstrap killed by BGTaskScheduler picks up at the page it
 * reached and still commits — and replays — at the ORIGINAL page-one cursor.
 */
export async function runWindowedBootstrap(
  options: RunWindowedBootstrapOptions
): Promise<ReplicaCursor> {
  const resumed = await attemptWindowedBootstrap(options, false);
  if (resumed) return resumed;
  // The persisted token no longer names a position the gateway will serve
  // (epoch/schema/shape drift, or a GC'd delta floor). Exactly one restart: a
  // fresh page one, a cleared walk, and a second refusal is the caller's — a
  // restarted walk resumes nothing, so it raises the refusal instead of
  // reporting it here.
  const restarted = await attemptWindowedBootstrap(options, true);
  if (restarted) return restarted;
  throw new ReplicaProtocolError("Replica bootstrap restart did not complete");
}

/** Resolves to the converged cursor, or undefined when a RESUMED walk was refused. */
async function attemptWindowedBootstrap(
  options: RunWindowedBootstrapOptions,
  restart: boolean
): Promise<ReplicaCursor | undefined> {
  const signal = options.signal ?? new AbortController().signal;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const window = options.window ?? DEFAULT_REPLICA_BOOTSTRAP_WINDOW;
  const fetchOptions = {
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const first = (await fetchReplicaBootstrapPage(options.gatewayAuth, {
    window,
    priority: "newest",
    ...fetchOptions,
  })) as ReplicaBootstrapFirstPage;

  const header: ReplicaBootstrapHeader = {
    protocolVersion: first.protocolVersion,
    vaultId: first.vaultId,
    schemaEpoch: first.schemaEpoch,
    shapes: first.shapes,
  };

  const resume = await options.target.bootstrapBegin(
    header,
    restart ? { restart: true } : undefined
  );
  // The delta floor for the convergence replay below. A resumed walk keeps the
  // ORIGINAL page-one cursor: this fetch's cursor is newer, and committing at
  // it would skip the very deltas the replay exists to apply.
  const commitCursor = resume?.commitCursor ?? first.cursor;
  let after = resume ? resume.after : (first.next ?? null);
  let pages = resume?.pages ?? 1;

  // Page one lands on every attempt. It is the newest era — the rows the grid
  // paints first — and re-applying it is an idempotent upsert either way.
  await options.target.bootstrapPage(first.rows, {
    after,
    commitCursor,
    pages,
  });
  // The preview cursor describes what is READABLE now, so it takes this
  // fetch's cursor and never regresses; the commit cursor above is separate.
  await options.target.bootstrapPreview?.(first.cursor);
  await options.onFirstPage?.(first.cursor, header);
  options.onProgress?.(pages);

  /*
   * A LOOP, not recursion (#659 set the discipline in
   * `packages/server/src/routes/replica-routes.ts`). `applyNextPage()` calling
   * itself once per page kept every page's frame and promise alive until the
   * last one settled — memory growing with the library's size, on the platform
   * with the least of it, at the exact moment it is applying 5,000 rows a page.
   * Every exit is in this body: the abort, the page budget, a missing
   * continuation token, and the token running out.
   */
  /*
   * THE NEXT PAGE IS IN FLIGHT WHILE THIS ONE LANDS (#922 C5). A cold start
   * is thousands of rows over dozens of pages; fetching and applying strictly
   * in turn made the walk cost the SUM of both, with the network idle for
   * every apply and the store idle for every fetch.
   *
   * A discarded prefetch has its rejection absorbed: an error on the page in
   * hand is the one that must surface, and an unobserved sibling rejection
   * would otherwise crash the process instead.
   */
  const fetchPage = (token: string): Promise<ReplicaBootstrapPage> =>
    fetchReplicaBootstrapPage(options.gatewayAuth, {
      after: token,
      window,
      ...fetchOptions,
    });
  let inflight: Promise<ReplicaBootstrapPage> | undefined =
    after === null ? undefined : fetchPage(after);
  const discard = (): void => {
    inflight?.catch(() => undefined);
    inflight = undefined;
  };
  while (after !== null) {
    if (signal.aborted) {
      discard();
      throw new ReplicaProtocolError("Replica bootstrap was aborted");
    }
    pages += 1;
    if (pages > maxPages) {
      discard();
      throw new ReplicaProtocolError(
        "Replica bootstrap exceeded its page budget"
      );
    }
    let page: ReplicaBootstrapPage;
    try {
      // oxlint-disable-next-line no-await-in-loop
      page = await (inflight ?? fetchPage(after));
      inflight = undefined;
    } catch (error) {
      inflight = undefined;
      if (!restart && resume && isStaleResumeToken(error)) return undefined;
      throw error;
    }
    if (
      page.schemaEpoch !== header.schemaEpoch ||
      page.vaultId !== header.vaultId
    ) {
      throw new ReplicaProtocolError(
        "Replica bootstrap page changed identity mid-walk"
      );
    }
    if (!page.complete && page.next === undefined) {
      throw new ReplicaProtocolError(
        "Incomplete replica bootstrap page had no token"
      );
    }
    after = page.complete ? null : (page.next ?? null);
    // Start N+1 BEFORE applying N: the fetch and the apply overlap instead of
    // taking turns.
    if (after !== null && !signal.aborted && pages < maxPages) {
      inflight = fetchPage(after);
    }
    // Rows and the position they leave the walk at commit together.
    // oxlint-disable-next-line no-await-in-loop
    await options.target.bootstrapPage(page.rows, {
      after,
      commitCursor,
      pages,
    });
    options.onProgress?.(pages);
  }
  discard();

  const outcomes = (await options.reconcileOutcomes?.(commitCursor)) ?? [];
  const cursor = await options.target.bootstrapCommit(
    commitCursor,
    header,
    outcomes
  );
  return converge(options, cursor, signal);
}

/**
 * Mandatory convergence: replay until the log stops advancing. Bounded, and
 * stopping early is safe rather than silent — the replica is already committed
 * and its stored cursor advanced with every applied batch, so the session's
 * ordinary feed catch-up continues from exactly where this returns.
 */
async function converge(
  options: RunWindowedBootstrapOptions,
  from: ReplicaCursor,
  signal: AbortSignal
): Promise<ReplicaCursor> {
  const maxPasses = options.maxConvergePasses ?? DEFAULT_MAX_CONVERGE_PASSES;
  let at = from;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    if (signal.aborted) return at;
    // oxlint-disable-next-line no-await-in-loop
    const batch = await options.pullChanges(at, signal);
    // oxlint-disable-next-line no-await-in-loop
    const applied = await options.target.applyChanges(batch);
    if (applied.epoch === at.epoch && applied.seq <= at.seq) return at;
    at = applied;
  }
  return at;
}

/** A continuation the gateway will no longer serve: restart the walk once. */
function isStaleResumeToken(error: unknown): boolean {
  return (
    error instanceof ReplicaRebootstrapRequiredError ||
    (error instanceof ReplicaTransportError && error.status === 400)
  );
}
