import type { GatewayAuth } from "../gateway-auth.js";
import { ReplicaProtocolError } from "./errors.js";
import {
  DEFAULT_REPLICA_BOOTSTRAP_WINDOW,
  fetchReplicaBootstrapPage,
} from "./shell-transport.js";
import type {
  ReplicaBootstrapFirstPage,
  ReplicaBootstrapPage,
  ReplicaFetcher,
} from "./shell-transport.js";
import type {
  IntentOutcome,
  ReplicaBootstrapHeader,
  ReplicaChangeBatch,
  ReplicaCursor,
} from "./types.js";

/** Coordinator surface this driver needs — structural so tests can fake it. */
export interface WindowedBootstrapTarget {
  bootstrapBegin: (header: ReplicaBootstrapHeader) => Promise<void>;
  bootstrapPage: (rows: ReplicaBootstrapPage["rows"]) => Promise<void>;
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
  onFirstPage?: (
    cursor: ReplicaCursor,
    header: ReplicaBootstrapHeader
  ) => void | Promise<void>;
  onProgress?: (pages: number) => void;
}

const DEFAULT_MAX_PAGES = 10_000;

/**
 * Drive a windowed bootstrap to a converged replica. Pages come from their
 * OWN snapshots (not a consistent cut); the repair is structural — commit at
 * the PAGE-1 cursor and replay the change log from it, idempotently. Skipping
 * the replay would leak deletions forever.
 */
export async function runWindowedBootstrap(
  options: RunWindowedBootstrapOptions
): Promise<ReplicaCursor> {
  const signal = options.signal ?? new AbortController().signal;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const first = (await fetchReplicaBootstrapPage(options.gatewayAuth, {
    window: options.window ?? DEFAULT_REPLICA_BOOTSTRAP_WINDOW,
    priority: "newest",
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
  await options.target.bootstrapPreview?.(firstCursor);
  await options.onFirstPage?.(firstCursor, header);
  options.onProgress?.(1);

  const applyNextPage = async (
    page: ReplicaBootstrapPage,
    pages: number
  ): Promise<void> => {
    if (page.complete) return;
    if (signal.aborted)
      throw new ReplicaProtocolError("Replica bootstrap was aborted");
    const next = page.next;
    if (!next)
      throw new ReplicaProtocolError(
        "Incomplete replica bootstrap page had no token"
      );
    const nextPageCount = pages + 1;
    if (nextPageCount > maxPages) {
      throw new ReplicaProtocolError(
        "Replica bootstrap exceeded its page budget"
      );
    }
    const nextPage = await fetchReplicaBootstrapPage(options.gatewayAuth, {
      after: next,
      window: options.window ?? DEFAULT_REPLICA_BOOTSTRAP_WINDOW,
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (
      nextPage.schemaEpoch !== header.schemaEpoch ||
      nextPage.vaultId !== header.vaultId
    ) {
      throw new ReplicaProtocolError(
        "Replica bootstrap page changed identity mid-walk"
      );
    }
    await options.target.bootstrapPage(nextPage.rows);
    options.onProgress?.(nextPageCount);
    return applyNextPage(nextPage, nextPageCount);
  };
  await applyNextPage(first, 1);

  const outcomes = (await options.reconcileOutcomes?.(firstCursor)) ?? [];
  const cursor = await options.target.bootstrapCommit(
    firstCursor,
    header,
    outcomes
  );

  // Mandatory convergence: replay until the log stops advancing.
  const converge = async (at: ReplicaCursor): Promise<ReplicaCursor> => {
    if (signal.aborted) return at;
    const batch = await options.pullChanges(at, signal);
    const applied = await options.target.applyChanges(batch);
    if (applied.epoch === at.epoch && applied.seq <= at.seq) return at;
    return converge(applied);
  };
  return converge(cursor);
}
