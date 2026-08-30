// governance: allow-repo-hygiene file-size-limit (#872) an ambient script cannot be split — the first `import`/`export` turns it into a module and every global below stops being global, so all shell-client and handler contracts are restated in this one file by construction.
// Global ambient types for the blueprint apps (TS + CSS-modules conversion).
//
// These are GLOBALS on purpose: handlers and page code reference `HandlerArgs`,
// `HandlerCtx`, `VaultOutcome`, and `window.centraid` by bare name, so a
// types-only module never has to be imported for its side effect of existing
// (`import type` is stripped, but a global spares the ceremony entirely).
// Grounded in the real surfaces:
//   - `window.centraid` — the shell-provided app client
//     (packages/client/src/react/blueprints/centraid-inline.ts):
//     read/write/onChange.
//   - `ctx.vault` — the handler-side vault RPC surface
//     (packages/server/src/engine/worker/runner.ts `ScopedVault`,
//     packages/server/src/engine/types.ts `CommonHandlerArgs`/`ActionResult`).
//   - `VaultOutcome` — the typed-command result the element layer narrates
//     (packages/design/src/elements/feedback.ts `outcomeMessage`).
//
// This is an ambient script (no imports/exports), so every top-level type and
// interface below is a GLOBAL — visible unqualified from every app/handler,
// and `interface Window` merges into the DOM lib's global Window.

// ────────── Typed-command outcome ──────────

/** Terminal states a vault write settles into (the element layer's `outcomeMessage`). */
type VaultOutcomeStatus =
  | "executed"
  | "parked"
  | "queued"
  | "in-flight"
  | "failed"
  | "denied";

/**
 * The outcome of a typed-command invocation — `window.centraid.write(...)`
 * and `ctx.vault.invoke(...)` both settle to this. Only `status` is always
 * present; the rest are status-dependent (`output` on success, `reason`/
 * `predicate` on failure/denial, `invocationId`/`receiptId` for the receipt).
 */
interface VaultOutcome {
  status: VaultOutcomeStatus;
  output?: Record<string, unknown>;
  reason?: string;
  predicate?: string;
  message?: string;
  invocationId?: string;
  receiptId?: string;
  /** Machine code on a denial/error path (e.g. `VAULT_CONSENT`). */
  code?: string;
}

// ────────── ctx.vault (handler side) ──────────

/** A single `where` clause for a `ctx.vault.read`. `value` is omitted for the
 *  valueless operators (`is-null` / `not-null`), hence optional. */
interface VaultWhere {
  column: string;
  op: string;
  value?: unknown;
}

/** Consent-checked read of a canonical entity as a bounded window. */
interface VaultReadRequest {
  entity: string;
  where?: VaultWhere[];
  orderBy?: { column: string; dir?: "asc" | "desc" };
  limit?: number;
  purpose: string;
}

/** `ctx.vault.read` result: the projected rows plus the read's receipt id. */
interface VaultReadResult {
  rows: Record<string, unknown>[];
  receiptId?: string;
}

/** Full-text search over a text-indexed entity (each row carries `_snippet`). */
interface VaultSearchRequest {
  entity: string;
  query: string;
  where?: VaultWhere[];
  limit?: number;
  purpose: string;
}

interface VaultSearchResult {
  rows: Record<string, unknown>[];
  receiptId?: string;
}

/** Typed-command invocation: `{command, input, purpose}` → `VaultOutcome`. */
interface VaultInvokeRequest {
  command: string;
  input?: Record<string, unknown>;
  purpose: string;
}

/** The card resolver (#272): (type, id) refs → renderable cards. */
interface VaultResolveRequest {
  refs: Array<{ type: string; id: string }>;
  purpose: string;
}

interface VaultResolveResult {
  cards: Array<Record<string, unknown>>;
  receiptId?: string;
}

/**
 * The handler-side `ctx.vault` surface. Every call round-trips through the
 * worker boundary to the host, which holds the app's vault credential and
 * enforces consent — always `await`. Mirrors app-engine's `ScopedVault`.
 */
interface VaultApi {
  read: (request: VaultReadRequest) => Promise<VaultReadResult>;
  search: (request: VaultSearchRequest) => Promise<VaultSearchResult>;
  invoke: (request: VaultInvokeRequest) => Promise<VaultOutcome>;
  /** Query a registered app view, clamped to this app's grants. */
  query: (view: string, purpose: string) => Promise<unknown>;
  /** Commands discoverable by this app (name, schema, risk, confirmation). */
  describe: () => Promise<unknown>;
  /** This app's own invocations awaiting owner confirmation. */
  parked: () => Promise<unknown>;
  resolve: (request: VaultResolveRequest) => Promise<VaultResolveResult>;
  /** Plaintext of one entity's sealed columns — receipted per item (#293). */
  reveal: (request: Record<string, unknown>) => Promise<unknown>;
  /** Locker-only user-presence authentication; sessions stay host-memory-only (#630). */
  authenticate: (request: Record<string, unknown>) => Promise<unknown>;
  /** Size-bounded derivative content fetch. */
  content: (request: Record<string, unknown>) => Promise<unknown>;
}

type RecurrenceSemantics = "zoned" | "floating" | "all-day";

interface RecurrenceInstance {
  originalStart: string;
  start: string;
  wallStart: string;
  overlap: boolean;
}

interface RecurrenceException {
  originalStart: string;
  action: "skip" | "override";
  scope?: "occurrence" | "future";
  start?: string;
}

/** Deterministic shared time core exposed by the host worker. */
interface TimeApi {
  expandRecurrence: (input: {
    rrule: string;
    start: string;
    rangeFrom: string;
    rangeTo: string;
    timeZone?: string;
    semantics?: RecurrenceSemantics;
    maxInstances?: number;
  }) => RecurrenceInstance[];
  applyRecurrenceExceptions: (
    instances: readonly RecurrenceInstance[],
    exceptions: readonly RecurrenceException[]
  ) => RecurrenceInstance[];
  /**
   * The ONE member-facing recurrence summary ("Every other Friday · 5 times").
   * Apps render this string; a raw rule never reaches a surface.
   */
  describeRecurrence: (rrule: string) => string | null;
  /**
   * A repeating item never stacks: elapsed unactioned periods collapse into a
   * count beside the single live occurrence ("missed 4 · next is Friday").
   */
  collapseMissedOccurrences: (input: {
    rrule: string;
    scheduledStart: string;
    timeZone?: string;
    anchor?: "scheduled" | "completion";
    now: string;
    lastCompletedAt?: string;
  }) => { missed: number; nextDue: string | null };
  /** Shift a wall-clock or zoned instant without host-TZ conversion. */
  shiftTemporal: (value: string, deltaMs: number) => string;
}

/** Per-handler `ctx` (see worker/runner.ts): fetch, abort, vault, and time. */
interface HandlerCtx {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  abortSignal: AbortSignal;
  vault: VaultApi;
  time: TimeApi;
}

interface HandlerLog {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

interface HandlerAppRef {
  readonly id: string;
  readonly dir: string;
}

/** What the dispatcher expects an ACTION handler to return (app-engine `ActionResult`). */
interface ActionResult {
  status?: number;
  body?: unknown;
}

/**
 * Uniform handler argument bag. Actions destructure `{ body, ctx }`; queries
 * `{ query, ctx }` (URL params) or `{ ctx }`. Every field beyond `log`/`app`/
 * `ctx` is handler-kind-specific, hence optional here — pick the one your
 * handler kind receives (mirrors app-engine `CommonHandlerArgs` +
 * `Query`/`ActionHandlerArgs`).
 */
interface HandlerArgs {
  log: HandlerLog;
  app: HandlerAppRef;
  ctx: HandlerCtx;
  /** Action handlers: the parsed request body. */
  body?: unknown;
  /** Query handlers: the typed input (preferred; dispatcher.ts read()). */
  input?: Record<string, unknown>;
  /** Query handlers: the same input under its legacy URL-query name. */
  query?: Record<string, unknown>;
  /** Path params (reserved for future shape changes). */
  params?: Record<string, string>;
}

// ────────── window.centraid (page side) ──────────

/**
 * A change-feed event (the element layer's `onDataChange`). A non-empty `tables` list must
 * intersect an app's declared tables to fire; an empty list ("this app
 * acted") always fires. `intentId`/`intentState` mark optimistic overlay
 * updates.
 */
interface CentraidChangeDetail {
  tables?: string[];
  source?: string;
  intentId?: string;
  intentState?: string;
  ts?: number;
  /**
   * Which mounted scope burst (#599). A multi-scope app refetches ONLY
   * this scope; absent means "the ambient one" (single-scope surfaces). The
   * shell also fires `{source: 'scope-added', scope}` when an audience scope
   * hydrates after first paint.
   */
  scope?: string;
}

/**
 * One mounted scope of a multi-scope app (#599) — the member's own
 * library or a shared audience. `label` is the only scope string an app may
 * render; `canWrite` is the shell's already-resolved answer to "may this member
 * add here?", so apps disable rather than guess. Structurally identical to
 * `InlineScope` in `apps/inline-types.ts`, restated here because the ambient
 * global cannot import.
 */
interface CentraidScope {
  id: string;
  label: string;
  /** The member's own vault? The "somewhere other than my own" marker is
   *  exactly `personal === false` (#711). */
  personal?: boolean;
  color?: string;
  icon?: string;
  canWrite: boolean;
}

/** One durable member command waiting on (or settled by) its Commons steward.
 *  Its statuses are the pending-write outbox's own words (#750): one
 *  intent grammar across every surface that renders in-flight writes. */
interface CentraidCommonsIntent {
  intentId: string;
  grantId: string;
  actorPartyId: string;
  command: string;
  input: Record<string, unknown>;
  status: "queued" | "parked" | "executed" | "denied" | "expired" | "cancelled";
  reason?: string;
  stewardLabel?: string;
  createdAt: string;
  settledAt?: string;
}

/** The steward's answer to one Commons request (#872). Restated structurally
 *  rather than imported — this ambient file cannot import — and kept in step
 *  with `InlineCommonsIntentDecision` in packages/client's inline bridge. */
interface CentraidCommonsIntentDecision {
  intentId: string;
  grantId: string;
  decision: "approve" | "decline";
  /** The intent's status AFTER the answer, read off the seat that holds it. */
  status: CentraidCommonsIntent["status"];
  /** `false` when the request had already settled before this answer arrived. */
  decided: boolean;
  reason?: string;
  sequence?: number;
  receiptId: string;
}

/** One staged import batch (#290), as the review surface lists it. */
interface CentraidImportBatch {
  batchId: string;
  status: "draft" | "published" | "discarded";
  createdAt: string;
  resolvedAt: string | null;
  summary: Record<string, number>;
  kind: string | null;
  label: string | null;
}

/** One staged row awaiting the owner's review. */
interface CentraidImportRow {
  seq: number;
  entityType: string;
  externalId: string;
  disposition: "create" | "update" | "skip" | "merge-candidate";
  note: string | null;
  publishedEntityId: string | null;
  /** "columns seen → what they become", already phrased by the gateway. */
  mapping: string;
}

/** One scope's answer in a `readAll` fan-out. Errors are data, never throws. */
type CentraidScopeRead<T> =
  | { scope: string; ok: true; data: T }
  | { scope: string; ok: false; error: { code?: string; message: string } };

/**
 * The injected vault client. `read`/`write` are generic on their result so a
 * caller can name its projection shape (`read<BoardData>({query:'board'})`)
 * without an `any`; both default to a permissive object / `VaultOutcome`.
 */
interface CentraidClient {
  /** The app id this client is scoped to (present on the mock; may be absent). */
  appId?: string;
  /**
   * Every scope this app is mounted over, primary (the member's own) FIRST
   * (#599). Absent on single-scope hosts (the served bridge, the visual
   * harness mock); the SAME array grows in place as audiences hydrate, so read
   * it fresh rather than caching a snapshot.
   */
  scopes?: CentraidScope[];
  read: <T = Record<string, unknown>>(opts: {
    query: string;
    input?: Record<string, unknown>;
    signal?: AbortSignal;
    /** Which mounted scope to read; defaults to the primary. */
    scope?: string;
  }) => Promise<T>;
  /**
   * Fan one query across scopes (#599). Settled per scope — one audience
   * failing never sinks the others — so it resolves with an answer per scope
   * and never rejects. `scopes` restricts the fan-out (e.g. "Show more" hits
   * only the horizon scopes). Absent on single-scope hosts.
   */
  readAll?: <T = Record<string, unknown>>(opts: {
    query: string;
    input?: Record<string, unknown>;
    signal?: AbortSignal;
    scopes?: readonly string[];
  }) => Promise<CentraidScopeRead<T>[]>;
  write: <T = VaultOutcome>(opts: {
    action: string;
    input?: Record<string, unknown>;
    intentId?: string;
    signal?: AbortSignal;
    /** Which mounted scope the write lands in; defaults to the primary. */
    scope?: string;
    /** Never enter a replica/outbox; a network failure rejects immediately. */
    onlineOnly?: boolean;
  }) => Promise<T>;
  /** Retry a retained denied/conflict/failed outbox record as a new intent. */
  retryPendingWrite?: (intentId: string, scope?: string) => Promise<boolean>;
  /** Permanently discard a retained denied/conflict/failed outbox record. */
  discardPendingWrite?: (intentId: string, scope?: string) => Promise<boolean>;
  /** Navigate to the shell-owned approval inbox when this host provides one. */
  openApprovals?: () => void;
  /**
   * Leave this app for another first-party one (#834). The projection doctrine
   * needs exactly this and nothing more: Agenda's due-task shelf shows that a
   * task comes due and hands the tap-through to Tasks, which is the room that
   * owns it. `focus` names what the destination should land on when it can;
   * a host that cannot honour it still opens the app rather than refusing.
   *
   * Absent on hosts with no navigation of their own (the served harness), and
   * an app must then draw NO control rather than a dead one.
   */
  openApp?: (appId: string, focus?: { taskId?: string }) => void;
  /** Durable member-side Commons overlay; absent on older/single-scope hosts. */
  commonsIntents?: (opts?: {
    scope?: string;
    signal?: AbortSignal;
  }) => Promise<CentraidCommonsIntent[]>;
  /** Cancel a Commons intent that has not executed yet; a steward that has already executed it wins. */
  cancelCommonsIntent?: (opts: {
    intentId: string;
    scope?: string;
  }) => Promise<{ status: string; cancelled: boolean }>;
  /**
   * The STEWARD's answer to one member request (#872) — approve runs it on the
   * signed rail, decline settles it `denied` with these words. Absent on a host
   * that has no such door, and a surface must then draw NO Approve/Decline
   * rather than a control that cannot fire.
   *
   * `scope` names the seat the answer is given FROM. The gateway finds the
   * intent's own seat and refuses anyone who is not that grant's steward; a
   * member withdrawing their own request uses `cancelCommonsIntent` instead.
   * An answer that arrived after the request already settled comes back
   * `decided: false` with the status that actually stands — not an error.
   */
  decideCommonsIntent?: (opts: {
    intentId: string;
    decision: "approve" | "decline";
    reason?: string;
    scope?: string;
  }) => Promise<CentraidCommonsIntentDecision>;
  /**
   * THE STAGED-IMPORT WORKFLOW (#290): a dropped file becomes a reviewable
   * DRAFT batch, its rows are read, and the batch is then published or
   * discarded. Absent on hosts without the owner import plane.
   *
   * ONLINE-ONLY BY CONSTRUCTION — never a replica session, never the
   * pending-write outbox: the payload is the file itself, secrets included,
   * and a durable offline queue is exactly where it must not sit.
   *
   * ACTIVE-VAULT SCOPED, hence NO `scope` argument: the import plane answers
   * for whichever vault the gateway has mounted, which is a different axis from
   * an app's mounted scopes. An app cannot stage into a secondary audience, and
   * the missing argument says so instead of accepting one and ignoring it.
   */
  stageImport?: (file: File) => Promise<{
    batchId: string;
    kind: string;
    staged: Record<string, number>;
    total: number;
    unrouted: string[];
  }>;
  importBatches?: () => Promise<CentraidImportBatch[]>;
  importRows?: (batchId: string) => Promise<CentraidImportRow[]>;
  publishImport?: (batchId: string) => Promise<{
    created: number;
    updated: number;
    skipped: number;
    failed: unknown[];
  }>;
  discardImport?: (batchId: string) => Promise<{ receiptId: string }>;
  /** Place an entity into another mounted audience vault. */
  place?: (opts: {
    linkToken: string;
    kind: "add" | "move";
    itemType:
      | "core.collection"
      | "core.content_item"
      | "core.document"
      | "docs.folder"
      | "locker.item"
      | "media.asset"
      | "tally.group";
    itemId: string;
    sourceVaultId: string;
    targetVaultId: string;
  }) => Promise<{
    status: string;
    targetItemId?: string;
    accessReceiptId?: string;
    reason?: string;
  }>;
  /** Share one container as circle-backed commons. */
  share?: (opts: {
    containerType:
      | "core.collection"
      | "core.content_item"
      | "core.document"
      | "docs.folder"
      | "locker.item"
      | "media.asset"
      | "tally.group";
    containerId: string;
    sourceVaultId: string;
    members: Array<{
      /** Required for an unmounted linked peer; local vaults resolve it at the gateway. */
      partyId?: string;
      /** Absent until an invited person creates and joins with a vault. */
      vaultId?: string;
      capability: "read" | "read+write";
    }>;
    circleId?: string;
  }) => Promise<{
    grantId: string;
    claims: Array<{ partyId: string; claimToken: string }>;
    [key: string]: unknown;
  }>;
  /** People-directory identities, including invitations with no vault yet. */
  shareTargets?: () => Promise<
    Array<{
      partyId: string;
      label: string;
      vaultId?: string;
    }>
  >;
  /** Mint a People person inline from the ShareSheet. Online-only: resolves
   *  only with a real, settled party id — never a pending overlay id. */
  quickAddPerson?: (opts: {
    name: string;
  }) => Promise<{ partyId: string; label: string }>;
  /** Named Tally-backed circles only; implicit per-container circles never
   * appear here. */
  shareCircles?: () => Promise<
    Array<{
      circleId: string;
      label: string;
      members: Array<{
        partyId: string;
        vaultId?: string;
        capability: "read" | "read+write";
      }>;
    }>
  >;
  commonsResidents?: (actorVaultId?: string) => Promise<
    Array<{
      grantId: string;
      itemType: string;
      itemId: string;
      originItemId: string;
    }>
  >;
  retainCommonsItem?: (opts: {
    actorVaultId: string;
    itemType: string;
    itemId: string;
  }) => Promise<{ retained: boolean; grantIds: string[] }>;
  /** The household's cross-vault links (#726) — candidate share
   *  destinations beyond the member's own mounted scopes, co-hosted and
   *  remote alike (D3: locality is routing, not semantics). */
  links?: () => Promise<
    Array<{
      linkId: string;
      vaultId: string;
      partyId: string;
      approved: boolean;
    }>
  >;
  /**
   * The GRANT PLANE (#825) — standing shares over `/centraid/_vault/grants`.
   * Every call answers the route's parsed JSON body as `unknown`: the parsing
   * and refusal law lives once in `_shared/grant-door.ts`, shared with the
   * native seat, so no app reads a payload itself. A refused call rejects with
   * the route's OWN message, which the sheet prints verbatim.
   *
   * The bridge is the shared `GrantWireCalls` since #883, built by the shell
   * over `_shared/grant-transport.ts` — this declaration is its shape at the
   * host boundary, not a second transport.
   */
  grants?: {
    subjects: () => Promise<unknown>;
    forParty: (partyId: string) => Promise<unknown>;
    /** `undefined` for an audience this vault has no record of (404). */
    forAudience: (
      kind: "party" | "circle",
      id: string
    ) => Promise<unknown | undefined>;
    forSubject: (subjectType: string, subjectId: string) => Promise<unknown>;
    create: (request: {
      audienceKind: "party" | "circle";
      audienceId: string;
      subjectType: string;
      subjectId: string;
      capability: "view" | "edit";
      subjectLabel?: string;
    }) => Promise<unknown>;
    revoke: (grantId: string) => Promise<unknown>;
  };
  describe?: () => Promise<unknown>;
  /** Subscribe to the change feed; returns the unsubscribe. */
  onChange: (cb: (detail: CentraidChangeDetail) => void) => () => void;
  /**
   * Read vault text through the shell's authenticated blob transport. The
   * shell's document origin is not the gateway — the installable web PWA rides
   * the iroh tunnel and desktop runs from `file://` — so a relative fetch of a
   * content URI resolves nowhere and carries no credential.
   */
  blobText?: (pathname: string, scope?: string) => Promise<string | null>;
  /** An authed `blob:` URL for a `/_vault/blobs/…` path, in one scope. */
  blobUrl?: (pathname: string, scope?: string) => Promise<string | null>;
  /**
   * Stream a File into the vault's blob CAS. The upload half of the same
   * authenticated door — the element layer's `stageFileBytes` is a thin
   * feature-detected wrapper over this, and the transport lives in the shell
   * (packages/client blob-staging.ts).
   */
  stageBlob?: (
    file: File,
    extra?: string,
    options?: { hash?: boolean; scope?: string }
  ) => Promise<StagedBlob>;
  /** Submit a typed derivative contribution against a staged parent's sha. */
  stageDerivative?: (
    parentSha: string,
    variant: string,
    body: BodyInit,
    mediaType?: string
  ) => Promise<StagedBlob>;
  /** Native haptics bridge (mobile shell only; feature-detected). */
  haptic?: Record<string, (() => void) | undefined>;
}

/** The staging receipt the blob door returns for one contribution. */
interface StagedBlob {
  sha256: string;
  mediaType?: string | null;
  byteSize?: number;
  existingContentId?: string | null;
  casAck?: string | null;
  custody?: string | null;
  alreadyPresent?: boolean;
  [key: string]: unknown;
}

interface Window {
  centraid: CentraidClient;
}
