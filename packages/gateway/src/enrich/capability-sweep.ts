// The capability sweep (issue #724 W3): ONE bounded pass that turns a backlog
// of targets into derived rows, for every enrichment capability there is.
//
// WHY GENERIC. The embedding indexer, the OCR pass, the face pass and the
// transcript pass differ in exactly three places — which rows are behind, what
// bytes to send, and where the answer is written — and agree on everything
// that is hard: the consent gate, the queue-is-the-database resume story, the
// batch cap, per-item failure isolation, the stamp/drain transaction, and the
// honest no-op when the service is not there. Four copies of the hard part is
// four places for those invariants to drift; a spec per capability is one.
//
// THE QUEUE IS THE DATABASE (issue #721 E2, unchanged). No in-memory work
// list, no cursor across ticks, no "resume from where we crashed" bookkeeping,
// because each is state that can disagree with the vault. A pass asks two
// questions, both answered by SQL over durable rows: the owner's own OPEN
// REQUESTS first (`enrich_request`), then the BACKFILL of targets this model
// has not produced yet. A killed gateway resumes by asking the same two
// questions; what it half-did is simply still open.
//
// DERIVATIVES, NEVER ORIGINALS. `buildItem` reads a target's preview/thumb (or
// other derived) bytes. A spec that reaches for an owner's full-resolution
// original to feed a model is a bug in that spec, and the comment in each spec
// says so — the guarantee is worth restating everywhere it can be broken.
//
// CONSENT IS READ BEFORE THE NETWORK. The `enrich_policy` gate is checked
// FIRST, before the service is even probed: on a vault whose owner set the
// domain to `off` or `device`, this pass makes no request, reads no blob, and
// returns having written nothing. `off` must not be observable as traffic.
//
// THE STAMP AND THE DRAIN ARE THIS MODULE'S JOB, not the spec's. A spec writes
// the derived value; this module opens the transaction around it and adds the
// `enrich_derivation` stamp and the `drained_at` marks. Two failure modes are
// unrecoverable if they are ever separated: a stamp without its value tells
// the next sweep the work is done when nothing was produced, and a drain
// without its value silently answers an owner's ask with nothing — a drained
// request is invisible to the claim query, so no later pass repairs it.
// Holding that invariant centrally means a new spec cannot get it wrong.

import { readEnrichPolicyTier, stampDerivation } from "@centraid/vault";
import type { EnrichDomain, VaultDb } from "@centraid/vault";

import {
  MAX_ENRICH_BATCH,
  enrichBatch,
  probeEnrichService,
} from "./service-client.js";
import type {
  EnrichCallOptions,
  EnrichCapability,
  EnrichServiceConfig,
} from "./service-client.js";
import { isEnrichFailure } from "./wire-shapes.js";
import type { EnrichItem, EnrichResult } from "./wire-shapes.js";

/** One entity this pass may derive, plus the asks it would answer. */
export interface CapabilitySweepTarget {
  id: string;
  /** Open `enrich_request` rows drained in the same transaction as the write. */
  requestIds: readonly string[];
}

/** What one pass found to do. Produced by a spec's `selectBacklog`. */
export interface CapabilitySweepBacklog {
  targets: CapabilitySweepTarget[];
  /**
   * Standing domain-wide asks (`enrich_request.target_id IS NULL` — "index my
   * photos"), drained only once `exhausted` says the library has nothing left.
   */
  domainRequestIds: readonly string[];
  /** True when this pass reached the end of the backlog rather than its cap. */
  exhausted: boolean;
}

export interface CapabilitySweepSelection {
  limit: number;
  /** The model the service says would run — the key a backfill selects on. */
  model: string;
  now: string;
}

export interface CapabilitySweepApply<C extends EnrichCapability> {
  target: CapabilitySweepTarget;
  result: EnrichResult<C>;
  model: string;
  now: string;
}

/**
 * The three things a capability knows that the sweep does not. Everything
 * else — consent, batching, isolation, provenance, drain — is above.
 */
export interface CapabilitySweepSpec<C extends EnrichCapability> {
  readonly capability: C;
  /** Which `enrich_policy` domain must be at the `gateway` tier for this to run. */
  readonly policyDomain: EnrichDomain;
  /** The entity family derived rows are keyed by, e.g. `media.media_asset`. */
  readonly targetType: string;
  /** What is produced, as `enrich_derivation.variant` records it. */
  readonly variant: string;
  /** Open requests FIRST, then unstamped/superseded targets. Bounded by `limit`. */
  selectBacklog: (
    db: VaultDb,
    input: CapabilitySweepSelection
  ) => CapabilitySweepBacklog;
  /**
   * The wire item for one target, or `null` when its bytes are not there yet
   * (no derivative rung) — a skip, never a read of the owner's original.
   */
  buildItem: (
    db: VaultDb,
    target: CapabilitySweepTarget
  ) => Promise<EnrichItem<C> | null>;
  /**
   * Write the derived value. The caller has a transaction open and adds the
   * stamp and the drain to it; a returned value becomes the stamp's payload.
   */
  apply: (db: VaultDb, input: CapabilitySweepApply<C>) => unknown;
}

export interface CapabilitySweepResult {
  /**
   * `ok` — the pass ran (possibly finding nothing to do).
   * `unavailable` — no service, or it does not offer this capability.
   * `policy` — the domain is not at the `gateway` tier.
   */
  status: "ok" | "unavailable" | "policy";
  capability: EnrichCapability;
  /** The model rows were written under, or null when the pass did not run. */
  model: string | null;
  /** Why the pass did not run, in a sentence. Absent when it did. */
  reason?: string;
  /** Targets examined this pass (bounded by the batch cap). */
  scanned: number;
  /** Targets whose derived value was written. */
  derived: number;
  /** `enrich_request` rows stamped `drained_at` by this pass. */
  drained: number;
  /** Targets with no derivative bytes yet — retried after one lands. */
  skipped: number;
  /** Targets the service could not derive. Counted, never fatal to the batch. */
  failed: number;
}

export interface CapabilitySweepOptions {
  /** The host's enrichment service, or `null` for "this host has none". */
  config: EnrichServiceConfig | null;
  /** Targets per pass. Clamped to the client's own batch ceiling. */
  batchSize?: number;
  now?: string;
  /** Reason one target failed — surfaced to the plane's operator log. */
  onFailure?: (targetId: string, reason: string) => void;
  /** Test seam: a lowered timeout, an injected fetch. */
  call?: EnrichCallOptions;
}

function emptyResult(
  status: CapabilitySweepResult["status"],
  capability: EnrichCapability,
  model: string | null,
  reason?: string
): CapabilitySweepResult {
  return {
    status,
    capability,
    model,
    ...(reason === undefined ? {} : { reason }),
    scanned: 0,
    derived: 0,
    drained: 0,
    skipped: 0,
    failed: 0,
  };
}

/** Yield the event loop between targets — indexing never starves live work. */
function yieldTick(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * One bounded pass for one capability. Safe to call on any cadence and from a
 * cold start: it holds nothing between calls.
 */
export async function runCapabilitySweep<C extends EnrichCapability>(
  db: VaultDb,
  spec: CapabilitySweepSpec<C>,
  options: CapabilitySweepOptions
): Promise<CapabilitySweepResult> {
  // Consent before contact — see the header. Read fresh every pass so an owner
  // turning enrichment off stops the NEXT sweep without a remount.
  if (readEnrichPolicyTier(db.vault, spec.policyDomain) !== "gateway")
    return emptyResult("policy", spec.capability, null);

  const probe = await probeEnrichService(
    options.config,
    spec.capability,
    options.call ?? {}
  );
  if (probe.status === "unavailable") {
    return emptyResult("unavailable", spec.capability, null, probe.reason);
  }
  const model = probe.model;
  const limit = Math.min(
    MAX_ENRICH_BATCH,
    Math.max(0, Math.trunc(options.batchSize ?? MAX_ENRICH_BATCH))
  );
  const now = options.now ?? new Date().toISOString();
  const result = emptyResult("ok", spec.capability, model);
  if (limit === 0) return result;

  const backlog = spec.selectBacklog(db, { limit, model, now });

  // Items are built ONE AT A TIME with a yield between: reading a derivative
  // can fall through to custody, and a sweep owes the loop pace even before it
  // owes the service a batch. Recursive rather than an awaiting loop for the
  // same reason `blob/preview.ts`'s backstop is — the reads must be sequential,
  // so `Promise.all` is the wrong shape here, not merely another style.
  const items: EnrichItem<C>[] = [];
  const pending: CapabilitySweepTarget[] = [];
  async function buildNext(index: number): Promise<void> {
    const target = backlog.targets[index];
    if (!target) return;
    result.scanned += 1;
    const item = await spec.buildItem(db, target);
    if (item) {
      items.push(item);
      pending.push(target);
      await yieldTick();
    } else result.skipped += 1;
    return buildNext(index + 1);
  }
  await buildNext(0);

  if (items.length > 0) {
    const outcome = await enrichBatch(
      options.config,
      spec.capability,
      items,
      options.call ?? {}
    );
    if (outcome.status === "unavailable") {
      // The service answered the probe and then went away. Nothing is written
      // and nothing is drained, so the same targets are still behind next pass.
      return { ...result, status: "unavailable", reason: outcome.reason };
    }
    outcome.results.forEach((item, index) => {
      const target = pending[index];
      if (!target) return;
      if (isEnrichFailure(item)) {
        result.failed += 1;
        options.onFailure?.(target.id, item.error);
        return;
      }
      result.drained += writeDerivation(db, spec, {
        target,
        result: item,
        // The model the batch actually ran under, not the probed one: a
        // service upgraded between the two calls must key its rows honestly.
        model: outcome.model,
        now,
      });
      result.derived += 1;
    });
  }

  // A standing "index my photos" is answered only by a pass that saw the end
  // of the library; a pass that filled its batch cannot know it did.
  if (backlog.exhausted && backlog.domainRequestIds.length > 0)
    result.drained += drainRequests(db, backlog.domainRequestIds, now);

  return result;
}

/**
 * Value, stamp and drain in ONE transaction — the invariant this module owns.
 * See the header for what each pairwise split would cost. Returns how many
 * requests this target actually closed.
 */
function writeDerivation<C extends EnrichCapability>(
  db: VaultDb,
  spec: CapabilitySweepSpec<C>,
  input: CapabilitySweepApply<C>
): number {
  db.vault.exec("BEGIN IMMEDIATE");
  try {
    const payload = spec.apply(db, input);
    stampDerivation(db.vault, {
      targetType: spec.targetType,
      targetId: input.target.id,
      variant: spec.variant,
      capability: spec.capability,
      model: input.model,
      ...(payload === undefined ? {} : { payload }),
      now: input.now,
    });
    const drained = markDrained(db, input.target.requestIds, input.now);
    db.vault.exec("COMMIT");
    return drained;
  } catch (error) {
    db.vault.exec("ROLLBACK");
    throw error;
  }
}

/** Stamp `drained_at` on requests this pass answered, in their own transaction. */
function drainRequests(
  db: VaultDb,
  requestIds: readonly string[],
  now: string
): number {
  db.vault.exec("BEGIN IMMEDIATE");
  try {
    const drained = markDrained(db, requestIds, now);
    db.vault.exec("COMMIT");
    return drained;
  } catch (error) {
    db.vault.exec("ROLLBACK");
    throw error;
  }
}

/** Caller owns the transaction. Mirrors `enrich.mark_requests_drained`. */
function markDrained(
  db: VaultDb,
  requestIds: readonly string[],
  now: string
): number {
  if (requestIds.length === 0) return 0;
  const mark = db.vault.prepare(
    `UPDATE enrich_request SET drained_at = ?
      WHERE request_id = ? AND drained_at IS NULL
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`
  );
  let drained = 0;
  for (const requestId of requestIds)
    drained += Number(mark.run(now, requestId, now).changes);
  return drained;
}

/**
 * The shared half of every spec's `selectBacklog`: the owner's OPEN requests
 * for this capability, split into per-target asks and standing domain-wide
 * ones. A row under a LIVE device lease is left alone — that device claimed
 * the work and the gateway is not its competitor.
 *
 * `capabilityNames` lists the `required_capability` / `contribution_variant`
 * tokens a request may carry for this work. They are the ENRICH_REQUEST
 * vocabulary (`embedding`, `ocr`, `transcript`), which predates the wire
 * capability names (`embed-image`, …) and is not being renamed under a live
 * queue — a request queued before this deploy must still be answerable.
 *
 * `consentCapabilities` is the THIRD vocabulary on this row, and the only one
 * that is a consent record rather than a routing hint: `enrich_request.
 * capability` (schema/enrich.ts) names the enricher an owner's `manual` ask is
 * FOR. It is separate because the other two columns are CHECK-constrained to
 * closed enums that a capability shipped after their DDL cannot join — which
 * is exactly the case for `faces` — and because a row carrying it means
 * something stronger: the owner asked for this, by name. A spec whose backlog
 * is gated on consent (faces-sweep.ts) matches on this list; the ambient
 * backfill specs pass none and are unaffected.
 */
export function selectOpenRequests(
  db: VaultDb,
  input: {
    targetType: string;
    capabilityNames: readonly string[];
    consentCapabilities?: readonly string[];
    limit: number;
    now: string;
  }
): { byTarget: Map<string, string[]>; order: string[]; domain: string[] } {
  const placeholders = input.capabilityNames.map(() => "?").join(",");
  const consent = input.consentCapabilities ?? [];
  const consentPlaceholders = consent.map(() => "?").join(",");
  const consentClause = consent.length
    ? ` OR capability IN (${consentPlaceholders})`
    : "";
  const rows = db.vault
    .prepare(
      `SELECT request_id, target_id FROM enrich_request
        WHERE drained_at IS NULL
          AND target_type = ?
          AND (required_capability IN (${placeholders})
               OR contribution_variant IN (${placeholders})${consentClause})
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        ORDER BY requested_at
        LIMIT ?`
    )
    .all(
      input.targetType,
      ...input.capabilityNames,
      ...input.capabilityNames,
      ...consent,
      input.now,
      input.limit
    ) as unknown as { request_id: string; target_id: string | null }[];

  const byTarget = new Map<string, string[]>();
  const order: string[] = [];
  const domain: string[] = [];
  for (const row of rows) {
    if (row.target_id === null) {
      domain.push(row.request_id);
      continue;
    }
    const existing = byTarget.get(row.target_id);
    if (existing) existing.push(row.request_id);
    else {
      byTarget.set(row.target_id, [row.request_id]);
      order.push(row.target_id);
    }
  }
  return { byTarget, order, domain };
}
