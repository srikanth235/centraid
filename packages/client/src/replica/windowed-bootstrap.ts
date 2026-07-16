import { ReplicaProtocolError } from './errors.js';
import {
  DEFAULT_REPLICA_BOOTSTRAP_WINDOW,
  fetchReplicaBootstrapPage,
  type ReplicaBootstrapFirstPage,
  type ReplicaBootstrapPage,
  type ReplicaFetcher,
} from './shell-transport.js';
import type {
  IntentOutcome,
  ReplicaBootstrapHeader,
  ReplicaChangeBatch,
  ReplicaCursor,
} from './types.js';
import type { GatewayAuth } from '../gateway-auth.js';

/**
 * The coordinator surface this driver needs. Narrowed to a structural type so
 * the walk can be tested against a fake without a store or a worker.
 */
export interface WindowedBootstrapTarget {
  bootstrapBegin(header: ReplicaBootstrapHeader): Promise<void>;
  bootstrapPage(rows: ReplicaBootstrapPage['rows']): Promise<void>;
  bootstrapCommit(
    cursor: ReplicaCursor,
    header: ReplicaBootstrapHeader,
    outcomes?: IntentOutcome[],
  ): Promise<ReplicaCursor>;
  applyChanges(batch: ReplicaChangeBatch): Promise<ReplicaCursor>;
}

export interface RunWindowedBootstrapOptions {
  gatewayAuth: GatewayAuth;
  target: WindowedBootstrapTarget;
  fetcher?: ReplicaFetcher;
  /** Rows per page; the gateway bounds this to 1..20000. */
  window?: number;
  signal?: AbortSignal;
  /**
   * Durable intent outcomes to reconcile at commit, resolved against the page-1
   * cursor exactly as the single-shot path does.
   */
  reconcileOutcomes?: (cursor: ReplicaCursor) => Promise<IntentOutcome[]>;
  /** Delta pull used for the mandatory post-completion convergence replay. */
  pullChanges: (cursor: ReplicaCursor, signal: AbortSignal) => Promise<ReplicaChangeBatch>;
  /** Guards against a pathological server that never stops emitting pages. */
  maxPages?: number;
}

const DEFAULT_MAX_PAGES = 10_000;

/**
 * Drive a windowed bootstrap to a converged, readable replica.
 *
 * Each page is read from its OWN server snapshot, so the assembled rows are not
 * a consistent cut: a row deleted after page 1 but before the page that would
 * have carried it simply never appears, and a row inserted mid-walk may appear
 * from a later snapshot. The repair is structural rather than best-effort — the
 * replica commits at the PAGE-1 cursor (the minimum across pages) and then
 * replays the change log from it before reporting success. Every change that
 * slipped between per-page snapshots is in that log, and replaying it over rows
 * that may already reflect it is idempotent (upserts overwrite, deletes remove).
 *
 * Skipping the replay would leave deletions leaked into the replica forever;
 * it is therefore part of this function, not of its callers.
 */
export async function runWindowedBootstrap(
  options: RunWindowedBootstrapOptions,
): Promise<ReplicaCursor> {
  const signal = options.signal ?? new AbortController().signal;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const first = (await fetchReplicaBootstrapPage(options.gatewayAuth, {
    window: options.window ?? DEFAULT_REPLICA_BOOTSTRAP_WINDOW,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })) as ReplicaBootstrapFirstPage;

  const header: ReplicaBootstrapHeader = {
    protocolVersion: first.protocolVersion,
    vaultId: first.vaultId,
    schemaEpoch: first.schemaEpoch,
    shapes: first.shapes,
  };
  // Page 1's cursor is the delta floor for the convergence replay below.
  const firstCursor = first.cursor;

  await options.target.bootstrapBegin(header);
  await options.target.bootstrapPage(first.rows);

  let page: ReplicaBootstrapPage = first;
  let pages = 1;
  while (!page.complete) {
    if (signal.aborted) throw new ReplicaProtocolError('Replica bootstrap was aborted');
    const next = page.next;
    if (!next) throw new ReplicaProtocolError('Incomplete replica bootstrap page had no token');
    if (++pages > maxPages) {
      throw new ReplicaProtocolError('Replica bootstrap exceeded its page budget');
    }
    page = await fetchReplicaBootstrapPage(options.gatewayAuth, {
      after: next,
      window: options.window ?? DEFAULT_REPLICA_BOOTSTRAP_WINDOW,
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (page.schemaEpoch !== header.schemaEpoch || page.vaultId !== header.vaultId) {
      throw new ReplicaProtocolError('Replica bootstrap page changed identity mid-walk');
    }
    await options.target.bootstrapPage(page.rows);
  }

  const outcomes = (await options.reconcileOutcomes?.(firstCursor)) ?? [];
  let cursor = await options.target.bootstrapCommit(firstCursor, header, outcomes);

  // Mandatory convergence. Replay until the log stops advancing; only then is
  // the replica a faithful view of some real vault state.
  while (!signal.aborted) {
    const batch = await options.pullChanges(cursor, signal);
    const applied = await options.target.applyChanges(batch);
    if (applied.epoch === cursor.epoch && applied.seq <= cursor.seq) break;
    cursor = applied;
  }
  return cursor;
}
