// The pending-write overlay engine (issue #738).
//
// A device holds exactly two durable local truths — the replica (canonical
// rows as of the cursor) and the intent outbox (unsettled writes) — and the
// honest local read is their composition: replica ⊕ outbox. The replica layer
// already composes optimistic mutations over every read (`overlayMutations`,
// packages/client/src/replica/intents.ts); this module is the app-facing half:
// apps DECLARE how each write-bearing action projects into the rows their
// queries return, and one shared model tracks every unsettled write's status
// so a pending row can never silently disappear.
//
// Shared-engine doctrine (docs/blueprint-seats.md): build once, per-app never.
// Apps supply a `PendingProjectionDeclaration` (pure config, scope-kit style)
// and render what `rows()` reports. No app owns pending state; reload survival
// equals outbox survival by construction, because `restore()` rebuilds from
// the durable outbox — never from a gateway fetch, never from app memory.
//
// Both seats drive the SAME model: web/desktop through `window.centraid`
// (`write({optimistic})` + `pendingWrites()`), native mobile through its
// replica session. The module is pure — no DOM, no client imports — so it is
// importable from packages/blueprints and apps/mobile alike (the
// `_shared/face-crop` precedent).

// ---------- status grammar ----------

/**
 * The one status grammar a pending row renders (issue #738 commitment 3):
 * `queued`/`sending` → quiet chip; `parked` → chip + reason + the
 * owner-approval affordance; `denied`/`conflict`/`failed`/`expired`/
 * `cancelled` → the row persists with the explanation and edit/retry/discard.
 * Silent disappearance of a pending row is a defect class, not a styling
 * choice.
 *
 * Every settled-but-not-executed state keeps its OWN name (issue #731 goal 2,
 * preserved through the #738 migration): a write the steward let lapse
 * (`expired`) and one the member withdrew (`cancelled`) are different facts
 * from a write that was refused (`denied`) or that broke (`failed`), and
 * collapsing them would print a chip that lies about what happened.
 */
export type PendingWriteStatus =
  | "queued"
  | "sending"
  | "parked"
  | "denied"
  | "conflict"
  | "failed"
  | "expired"
  | "cancelled";

/** Statuses that keep overlaying reads from the durable outbox. */
const OVERLAY_STATUSES: ReadonlySet<PendingWriteStatus> = new Set([
  "queued",
  "sending",
  "parked",
]);

/** Terminal statuses a member may explicitly discard — never auto-removed. */
const DISMISSIBLE_STATUSES: ReadonlySet<PendingWriteStatus> = new Set([
  "denied",
  "conflict",
  "failed",
  "expired",
  "cancelled",
]);

/** Optimistic-concurrency detail a conflict row surfaces verbatim (P2):
 *  expected vs actual versions, never a generic transport error. */
export interface PendingConflictDetail {
  entity: string;
  rowId: string;
  expectedVersion: number;
  actualVersion: number;
}

// ---------- projection declaration ----------

/**
 * One optimistic mutation an action projects into an entity the app reads.
 * Structurally mirrors the replica's `OptimisticMutation` (sans `shapeId`,
 * which the shell resolves from the app's catalog); restated here because
 * blueprints cannot import from packages/client.
 */
export type PendingMutation =
  | {
      op: "upsert";
      entity: string;
      rowId: string;
      values: Record<string, unknown>;
    }
  | { op: "delete"; entity: string; rowId: string };

export interface PendingProjectionContext {
  intentId: string;
  /** Deterministic minted primary key for rows this write CREATES. */
  rowId: string;
}

/**
 * How one action's input projects into the rows the app's queries return.
 * A pure function of (input, ctx): a create upserts under `ctx.rowId`, an
 * edit upserts under the row id already in `input`, a delete emits a delete.
 * One write may project several mutations (e.g. an expense plus its
 * participant rows).
 */
export type PendingActionProjection = (
  input: Record<string, unknown>,
  ctx: PendingProjectionContext
) => PendingMutation[];

/**
 * The per-app declaration the engine consumes — pure config beside the app,
 * exactly like the scope kit's `ScopeAppDeclaration` and the search
 * scaffold's `SearchEntity[]`. An action absent from `actions` projects no
 * overlay (deliberately: some actions are honest about being online-only).
 */
export interface PendingProjectionDeclaration {
  appId: string;
  actions: Record<string, PendingActionProjection>;
  /**
   * Vault command name → declared action, for the commons rail only.
   *
   * A local write is issued by its APP ACTION name (`add-expense`), but a
   * durable commons intent records the VAULT COMMAND it will run
   * (`tally.add_expense`, `packages/vault/src/share/actable.ts`). The two
   * vocabularies are genuinely different strings, so an app whose actions can
   * pend on a steward maps them here; without the map, an enriched commons
   * intent would project nothing and the row would silently not render.
   */
  commands?: Record<string, string>;
}

/**
 * The declared action a name refers to, accepting either vocabulary: an app
 * action as-is, or a vault command through the declaration's `commands` map.
 * Returns undefined when the app declares no projection for it.
 */
export function resolveDeclaredAction(
  declaration: PendingProjectionDeclaration,
  name: string
): string | undefined {
  if (declaration.actions[name]) return name;
  const mapped = declaration.commands?.[name];
  return mapped && declaration.actions[mapped] ? mapped : undefined;
}

/**
 * The deterministic pending key (issue #738 open question, resolved): derived
 * from `intentId`, never from wall-clock or randomness, so replays and
 * reloads reconcile to the same row. When the intent executes, the canonical
 * row (with its real id) and the overlay removal land in the same change
 * batch — the swap is atomic, no flicker, no duplication.
 */
export function pendingRowId(intentId: string): string {
  return `pending-${intentId}`;
}

export function isPendingRowId(rowId: unknown): boolean {
  return typeof rowId === "string" && rowId.startsWith("pending-");
}

/** Project one write through the app's declaration. `[]` when undeclared. */
export function projectPendingMutations(
  declaration: PendingProjectionDeclaration,
  action: string,
  input: Record<string, unknown>,
  intentId: string
): PendingMutation[] {
  const projection = declaration.actions[action];
  if (!projection) return [];
  return projection(input, { intentId, rowId: pendingRowId(intentId) });
}

// ---------- status mapping ----------

/** Durable outbox state → chip status. The outbox is part of local truth, so
 *  its four unsettled states are the only reload-surviving statuses. */
export function pendingStatusFromIntentState(
  state: string
): PendingWriteStatus | undefined {
  switch (state) {
    case "queued":
      return "queued";
    case "sending":
    case "awaiting-change":
      return "sending";
    case "parked":
      return "parked";
    default:
      return undefined;
  }
}

/**
 * Write/settlement outcome → chip status. `executed` and `in-flight` return
 * their own markers so the model can settle or keep waiting; everything else
 * maps onto the row grammar.
 */
export function pendingStatusFromOutcome(
  status: string,
  hasConflict = false
): PendingWriteStatus | "executed" | undefined {
  if (status === "executed") return "executed";
  if (status === "in-flight") return "sending";
  if (status === "queued") return "queued";
  if (status === "parked") return "parked";
  if (status === "conflict" || hasConflict) return "conflict";
  if (status === "denied") return "denied";
  if (status === "failed") return "failed";
  return undefined;
}

// ---------- reason grammar ----------

/**
 * Honest copy per the refusal grammar (issue #738 commitment 4). A commons
 * write can legitimately pend for days, and the copy must say WHY: offline it
 * is "waiting for a connection" — naming a steward would be a lie, nothing
 * has been submitted — and online it names the steward the write waits on.
 * A gateway-supplied reason is printed verbatim (blueprint-seats.md grammar).
 */
export function pendingReasonCopy(
  status: PendingWriteStatus,
  opts: { reason?: string; online?: boolean; stewardLabel?: string } = {}
): string {
  if (opts.reason) return opts.reason;
  switch (status) {
    case "queued":
      return "Saved on this device; waiting for a connection.";
    case "sending":
      return "Sending…";
    case "parked":
      return opts.online === false
        ? "Saved on this device; waiting for a connection."
        : `Waiting for ${opts.stewardLabel || "approval"}.`;
    case "denied":
      return "This change was not allowed.";
    case "conflict":
      return "Someone else changed this first.";
    case "failed":
      return "This change could not be applied.";
    case "expired":
      return "This change expired before it was approved.";
    case "cancelled":
      return "This change was cancelled.";
    default:
      return "";
  }
}

/** The quiet chip label for a status — one word, one grammar, every seat. */
export function pendingChipLabel(status: PendingWriteStatus): string {
  switch (status) {
    case "queued":
      return "pending";
    case "sending":
      return "sending";
    case "parked":
      return "waiting";
    case "denied":
      return "denied";
    case "conflict":
      return "conflict";
    case "failed":
      return "failed";
    case "expired":
      return "expired";
    case "cancelled":
      return "cancelled";
    default:
      return "pending";
  }
}

// ---------- the model ----------

/** One unsettled (or attention-holding) write the app renders. */
export interface PendingRowState {
  intentId: string;
  action: string;
  status: PendingWriteStatus;
  /** Every row id this write projects into — pending-minted or canonical. */
  rowIds: string[];
  entities: string[];
  reason?: string;
  conflict?: PendingConflictDetail;
  /** Cached for edit/retry; scrubbed states after reload have none. */
  input?: Record<string, unknown>;
  /** Commons enrichment (online only): who the write waits on. */
  stewardLabel?: string;
  /** Server-side commons status when enrichment applies (issue #731). */
  commonsStatus?: string;
  /** True when the entry exists only as server-side commons enrichment —
   *  another device's write, or a settled intent the outbox scrubbed. */
  enrichmentOnly?: boolean;
}

/** The durable outbox slice a seat feeds `restore()` — the reload path. */
export interface DurablePendingWrite {
  intentId: string;
  action: string;
  state: string;
  reason?: string;
  input?: Record<string, unknown>;
  mutations?: readonly PendingMutation[];
}

/**
 * The durable ATTENTION slice a seat feeds `restoreAttention()` — the other
 * half of the reload path (issue #738). A settled write leaves the outbox, so
 * `restore()` alone can never bring a denied/conflicted/failed row back; this
 * comes from the client-local attention journal
 * (`window.centraid.attentionWrites()` on the web seat, the
 * `replica_intent_attention` table on the phone) and is what makes "the row
 * persists with its explanation" true across a reload instead of only within
 * one session's memory.
 */
export interface DurableAttentionWrite {
  intentId: string;
  action: string;
  status: "denied" | "conflict" | "failed";
  reason?: string;
  input?: Record<string, unknown>;
  mutations?: readonly PendingMutation[];
  conflict?: PendingConflictDetail;
}

/** The commons-intent slice `enrichCommons()` consumes (issue #731 rail). */
export interface CommonsIntentLike {
  intentId: string;
  command: string;
  status: string;
  reason?: string;
  stewardLabel?: string;
  input?: Record<string, unknown>;
}

/** The overlay-source change-feed slice `applyChangeDetail()` consumes. */
export interface PendingChangeDetail {
  source?: string;
  intentId?: string;
  intentState?: string;
}

interface PendingEntry {
  intentId: string;
  action: string;
  status: PendingWriteStatus;
  mutations: PendingMutation[];
  reason?: string;
  conflict?: PendingConflictDetail;
  input?: Record<string, unknown>;
  stewardLabel?: string;
  commonsStatus?: string;
  enrichmentOnly?: boolean;
}

/**
 * The one I/O port the model takes. The model stays pure — it holds no
 * transport and imports nothing — but a row the member DISCARDS (or takes for
 * a retry) has to leave the durable attention journal too, or the next reload
 * resurrects it. Wiring that per app would guarantee some app forgets, so the
 * engine calls the seat's clear function itself.
 */
export interface PendingOverlayPorts {
  /** Forget one attention record durably. Fire-and-forget by contract: the
   *  seat owns the failure narration, so this returns nothing. */
  dismissDurable?: (intentId: string) => void;
}

/** Commons statuses a member may dismiss once settled (issue #731 m6):
 *  terminal without an executed row to show for it. */
const DISMISSIBLE_COMMONS = new Set(["denied", "expired", "cancelled"]);

/** Server-side commons status → the row grammar. `pending` and `parked` both
 *  wait on the steward; every settled-but-not-executed state keeps its own
 *  name, so the chip says what actually happened rather than collapsing a
 *  lapsed or withdrawn request into a generic failure. */
function statusFromCommons(status: string): PendingWriteStatus | undefined {
  if (status === "pending" || status === "parked") return "parked";
  if (status === "denied") return "denied";
  if (status === "expired") return "expired";
  if (status === "cancelled") return "cancelled";
  return undefined; // executed: the canonical row carries the truth now
}

/**
 * The one pending-write model both seats drive. Pure state + transitions —
 * callers own I/O (issuing writes, reading the outbox, subscribing to the
 * change feed) and feed the results in. Laws:
 *
 * - `restore()` rebuilds overlay-status entries from the durable outbox and
 *   ONLY from it — attention entries (denied/conflict/failed) and commons
 *   enrichment survive a restore untouched, so no refresh can wipe a row the
 *   grammar says must persist (the issue #738 solo-vault wipe, fixed by
 *   construction).
 * - `restoreAttention()` rebuilds those attention entries from the durable
 *   attention journal. It only ever ADDS: an entry this session already
 *   knows, and one the member has dismissed, are both left alone.
 * - Terminal outcomes never auto-remove a row: `executed` settles it (the
 *   canonical row replaces it in the same change batch), everything else
 *   holds the row until an explicit `dismiss()`.
 * - `enrichCommons()` only ever ADDS information. An empty server answer
 *   removes nothing.
 */
export function createPendingOverlayModel(
  declaration: PendingProjectionDeclaration,
  ports: PendingOverlayPorts = {}
) {
  const entries = new Map<string, PendingEntry>();
  const dismissed = new Set<string>();

  const toRowState = (entry: PendingEntry): PendingRowState => ({
    intentId: entry.intentId,
    action: entry.action,
    status: entry.status,
    rowIds: entry.mutations.map((mutation) => mutation.rowId),
    entities: [...new Set(entry.mutations.map((mutation) => mutation.entity))],
    ...(entry.reason ? { reason: entry.reason } : {}),
    ...(entry.conflict ? { conflict: entry.conflict } : {}),
    ...(entry.input ? { input: entry.input } : {}),
    ...(entry.stewardLabel ? { stewardLabel: entry.stewardLabel } : {}),
    ...(entry.commonsStatus ? { commonsStatus: entry.commonsStatus } : {}),
    ...(entry.enrichmentOnly ? { enrichmentOnly: true } : {}),
  });

  return {
    /**
     * Record one write about to be issued and return the optimistic
     * mutations the seat passes to its replica write. The entry starts
     * `queued`; the write outcome and change feed move it from there.
     */
    begin(
      action: string,
      input: Record<string, unknown>,
      intentId: string
    ): PendingMutation[] {
      const mutations = projectPendingMutations(
        declaration,
        action,
        input,
        intentId
      );
      if (mutations.length === 0) return mutations;
      entries.set(intentId, {
        intentId,
        action,
        status: "queued",
        mutations,
        input,
      });
      dismissed.delete(intentId);
      return mutations;
    },

    /** Fold one write/settlement outcome into the row's status. */
    applyOutcome(
      intentId: string,
      outcome: {
        status: string;
        reason?: string;
        conflict?: PendingConflictDetail;
      }
    ): boolean {
      const entry = entries.get(intentId);
      if (!entry) return false;
      const status = pendingStatusFromOutcome(
        outcome.status,
        outcome.conflict !== undefined
      );
      if (status === undefined) return false;
      if (status === "executed") {
        entries.delete(intentId);
        return true;
      }
      entry.status = status;
      if (outcome.reason !== undefined) entry.reason = outcome.reason;
      if (outcome.conflict !== undefined) entry.conflict = outcome.conflict;
      return true;
    },

    /**
     * Fold one change-feed event. Only overlay-source events with a terminal
     * or transitional intent state matter; canonical bursts are the replica's
     * business. Returns true when the pending set changed.
     */
    applyChangeDetail(detail: PendingChangeDetail): boolean {
      if (detail.source !== "overlay" || !detail.intentId) return false;
      const entry = entries.get(detail.intentId);
      if (!entry || !detail.intentState) return false;
      if (detail.intentState === "executed") {
        entries.delete(detail.intentId);
        return true;
      }
      const status =
        pendingStatusFromIntentState(detail.intentState) ??
        pendingStatusFromOutcome(detail.intentState);
      if (status === undefined || status === "executed") return false;
      if (entry.status === status) return false;
      entry.status = status;
      return true;
    },

    /**
     * Rebuild overlay-status entries from the durable outbox — the reload
     * path, and the only source of truth for `queued`/`sending`/`parked`.
     * Attention entries persist across restores; a durable record that
     * disappeared because it EXECUTED is simply gone (the canonical row has
     * it now), which is the honest answer.
     */
    restore(durable: readonly DurablePendingWrite[]): void {
      const durableIds = new Set<string>();
      for (const record of durable) {
        const status = pendingStatusFromIntentState(record.state);
        if (status === undefined) continue;
        durableIds.add(record.intentId);
        const existing = entries.get(record.intentId);
        const mutations =
          record.mutations !== undefined && record.mutations.length > 0
            ? [...record.mutations]
            : (existing?.mutations ??
              projectPendingMutations(
                declaration,
                record.action,
                record.input ?? {},
                record.intentId
              ));
        // The durable record wins; what the model already knew survives a
        // record whose sensitive input the outbox scrubbed on settle.
        const reason = record.reason ?? existing?.reason;
        const input = record.input ?? existing?.input;
        entries.set(record.intentId, {
          intentId: record.intentId,
          action: record.action,
          status,
          mutations,
          ...(reason === undefined ? {} : { reason }),
          ...(input === undefined ? {} : { input }),
          ...(existing?.stewardLabel
            ? { stewardLabel: existing.stewardLabel }
            : {}),
          ...(existing?.commonsStatus
            ? { commonsStatus: existing.commonsStatus }
            : {}),
        });
      }
      for (const [intentId, entry] of entries) {
        if (durableIds.has(intentId)) continue;
        if (DISMISSIBLE_STATUSES.has(entry.status)) continue; // attention persists
        if (entry.enrichmentOnly) continue; // commons enrichment persists
        entries.delete(intentId);
      }
    },

    /**
     * Rebuild attention entries from the durable attention journal — the
     * reload path for denied/conflict/failed rows, which `restore()` cannot
     * see because the outbox drops a settled intent (issue #738).
     *
     * Purely additive, in both directions that matter: a row the member has
     * already dismissed stays dismissed (the journal is cleared on dismissal,
     * but a stale read racing that clear must not resurrect it), and an entry
     * this session already holds keeps whatever it learned at settle time —
     * a journal is a floor on what is known, never a ceiling.
     */
    restoreAttention(durable: readonly DurableAttentionWrite[]): void {
      for (const record of durable) {
        if (dismissed.has(record.intentId)) continue;
        if (entries.has(record.intentId)) continue;
        const mutations =
          record.mutations !== undefined && record.mutations.length > 0
            ? [...record.mutations]
            : projectPendingMutations(
                declaration,
                record.action,
                record.input ?? {},
                record.intentId
              );
        entries.set(record.intentId, {
          intentId: record.intentId,
          action: record.action,
          status: record.status,
          mutations,
          ...(record.reason === undefined ? {} : { reason: record.reason }),
          ...(record.input === undefined ? {} : { input: record.input }),
          ...(record.conflict === undefined
            ? {}
            : { conflict: record.conflict }),
        });
      }
    },

    /**
     * Merge the online commons rail (issue #731) as ENRICHMENT: steward
     * label and per-grant status onto matching local rows, and
     * enrichment-only rows for server-side intents the local outbox does not
     * hold. Adds information, never removes it — offline, rows render from
     * the outbox alone with generic pending copy.
     */
    enrichCommons(intents: readonly CommonsIntentLike[]): void {
      for (const intent of intents) {
        if (dismissed.has(intent.intentId)) continue;
        const existing = entries.get(intent.intentId);
        if (existing) {
          if (intent.stewardLabel) existing.stewardLabel = intent.stewardLabel;
          existing.commonsStatus = intent.status;
          if (intent.reason !== undefined) existing.reason = intent.reason;
          continue;
        }
        const status = statusFromCommons(intent.status);
        if (status === undefined) continue;
        // A commons intent names the VAULT COMMAND; the app declared APP
        // ACTIONS. Resolve before projecting, or the row renders as nothing.
        const action =
          resolveDeclaredAction(declaration, intent.command) ?? intent.command;
        const mutations = projectPendingMutations(
          declaration,
          action,
          intent.input ?? {},
          intent.intentId
        );
        entries.set(intent.intentId, {
          intentId: intent.intentId,
          action,
          status,
          mutations,
          ...(intent.reason === undefined ? {} : { reason: intent.reason }),
          ...(intent.input === undefined ? {} : { input: intent.input }),
          ...(intent.stewardLabel ? { stewardLabel: intent.stewardLabel } : {}),
          commonsStatus: intent.status,
          enrichmentOnly: true,
        });
      }
    },

    /**
     * Explicitly discard one attention row (denied/conflict/failed, or a
     * settled commons enrichment per issue #731 m6). A row still waiting —
     * queued, sending, parked, or a live commons pending/parked — is not
     * dismissible and the call is a no-op, so nothing waiting can be lost.
     *
     * The durable attention record goes with it (`ports.dismissDurable`):
     * discarding a row that comes back on the next reload is not discarding.
     */
    dismiss(intentId: string): boolean {
      const entry = entries.get(intentId);
      if (!entry) return false;
      const commonsSettled =
        entry.commonsStatus !== undefined &&
        DISMISSIBLE_COMMONS.has(entry.commonsStatus);
      if (!DISMISSIBLE_STATUSES.has(entry.status) && !commonsSettled)
        return false;
      entries.delete(intentId);
      dismissed.add(intentId);
      ports.dismissDurable?.(intentId);
      return true;
    },

    /**
     * Hand back what a retry needs — the cached action and input — and drop
     * the failed entry, durable record included: the retry is issued under a
     * FRESH intent id (the old id's payload hash is bound to the failed
     * attempt), so leaving the old record would leave a duplicate row behind
     * on the next reload.
     * Returns undefined for a row still in flight or with no cached input.
     */
    takeForRetry(
      intentId: string
    ): { action: string; input: Record<string, unknown> } | undefined {
      const entry = entries.get(intentId);
      if (!entry || !DISMISSIBLE_STATUSES.has(entry.status)) return undefined;
      if (entry.input === undefined) return undefined;
      entries.delete(intentId);
      dismissed.add(intentId);
      ports.dismissDurable?.(intentId);
      return { action: entry.action, input: entry.input };
    },

    /** Every tracked row, insertion-ordered. */
    rows(): PendingRowState[] {
      return [...entries.values()].map(toRowState);
    },

    /** Row-id → pending state, for decorating query rows with the chip. */
    byRowId(): Map<string, PendingRowState> {
      const index = new Map<string, PendingRowState>();
      for (const entry of entries.values()) {
        const state = toRowState(entry);
        for (const rowId of state.rowIds) index.set(rowId, state);
      }
      return index;
    },

    /** Rows in the attention grammar (denied/conflict/failed). */
    attention(): PendingRowState[] {
      return [...entries.values()]
        .filter((entry) => DISMISSIBLE_STATUSES.has(entry.status))
        .map(toRowState);
    },

    /** Rows still overlaying reads (queued/sending/parked). */
    unsettled(): PendingRowState[] {
      return [...entries.values()]
        .filter((entry) => OVERLAY_STATUSES.has(entry.status))
        .map(toRowState);
    },
  };
}

export type PendingOverlayModel = ReturnType<typeof createPendingOverlayModel>;
