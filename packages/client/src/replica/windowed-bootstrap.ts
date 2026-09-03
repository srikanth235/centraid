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
  window?: number;
  signal?: AbortSignal;
  reconcileOutcomes?: (cursor: ReplicaCursor) => Promise<IntentOutcome[]>;
  pullChanges: (
    cursor: ReplicaCursor,
    signal: AbortSignal
  ) => Promise<ReplicaChangeBatch>;
  maxPages?: number;
  maxConvergePasses?: number;
  onFirstPage?: (
    cursor: ReplicaCursor,
    header: ReplicaBootstrapHeader
  ) => void | Promise<void>;
  onProgress?: (pages: number) => void;
}

const DEFAULT_MAX_PAGES = 10_000;

const DEFAULT_MAX_CONVERGE_PASSES = 1_000;

export async function runWindowedBootstrap(
  options: RunWindowedBootstrapOptions
): Promise<ReplicaCursor> {
  const resumed = await attemptWindowedBootstrap(options, false);
  if (resumed) return resumed;
  const restarted = await attemptWindowedBootstrap(options, true);
  if (restarted) return restarted;
  throw new ReplicaProtocolError("Replica bootstrap restart did not complete");
}

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
  const commitCursor = resume?.commitCursor ?? first.cursor;
  let after = resume ? resume.after : (first.next ?? null);
  let pages = resume?.pages ?? 1;

  await options.target.bootstrapPage(first.rows, {
    after,
    commitCursor,
    pages,
  });
  await options.target.bootstrapPreview?.(first.cursor);
  await options.onFirstPage?.(first.cursor, header);
  options.onProgress?.(pages);

  while (after !== null) {
    if (signal.aborted)
      throw new ReplicaProtocolError("Replica bootstrap was aborted");
    pages += 1;
    if (pages > maxPages) {
      throw new ReplicaProtocolError(
        "Replica bootstrap exceeded its page budget"
      );
    }
    let page: ReplicaBootstrapPage;
    try {
      // oxlint-disable-next-line no-await-in-loop
      page = await fetchReplicaBootstrapPage(options.gatewayAuth, {
        after,
        window,
        ...fetchOptions,
      });
    } catch (error) {
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
    // oxlint-disable-next-line no-await-in-loop
    await options.target.bootstrapPage(page.rows, {
      after,
      commitCursor,
      pages,
    });
    options.onProgress?.(pages);
  }

  const outcomes = (await options.reconcileOutcomes?.(commitCursor)) ?? [];
  const cursor = await options.target.bootstrapCommit(
    commitCursor,
    header,
    outcomes
  );
  return converge(options, cursor, signal);
}

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

function isStaleResumeToken(error: unknown): boolean {
  return (
    error instanceof ReplicaRebootstrapRequiredError ||
    (error instanceof ReplicaTransportError && error.status === 400)
  );
}
