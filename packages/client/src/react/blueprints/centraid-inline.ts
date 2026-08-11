// governance: allow-repo-hygiene file-size-limit (#731) the inline host bridge keeps query, write, sharing, Commons claim, resident-save, and replica invalidation doors in one security boundary.
import type {
  InlineAppModule,
  InlineScope,
} from "@centraid/blueprints/apps/inline-types";
// The inline `window.centraid` — the shell-side replacement for the served
// bridge's `w.centraid` client (packages/app-engine bridge-script.ts). Backed
// by the shell replica session: reads run the app's query modules locally
// (inlineQueryCtx), writes go through the replica intent dispatch carrying the
// caller's `intentId` verbatim (#406 dedupe lives in the session/route — never
// re-minted here), and `onChange` is a replica-invalidation subscription mapped
// into the kit's `CentraidChangeDetail` shape.
//
// MULTI-SCOPE (issue #599). An app may be mounted over N scopes at once — the
// member's own scope plus every audience scope they belong to — each backed by
// its OWN replica session. The facade is therefore built from an ordered list of
// scope bindings whose FIRST entry is the primary (the member's own): `read`
// addresses the primary unless told otherwise, `readAll` fans out, `write`
// addresses one named scope and refuses a scope the member cannot write, and
// `onChange` fans in with every event tagged by the scope it came from.
//
// `createInlineCentraidClient` builds the client and writes nothing global;
// `installInlineCentraid` publishes it on `window.centraid` and returns a
// teardown that restores whatever was there before. Only one inline app is
// mounted at a time, so a single module-level install is still enough.
import { appQueryPath, ROUTES } from "@centraid/protocol";

import {
  auth,
  authHeaders,
  doFetch,
  readJson,
  VAULT_HEADER,
} from "../../gateway-client-core.js";
import type { ReplicaShellSession } from "../../replica/shell-session.js";
import type { ReplicaInvalidation } from "../../replica/types.js";
import { authorizeBlobUrl } from "./blob-auth.js";
import { runInlineQuery } from "./inlineQueryCtx.js";
import { placementWireFromEdge } from "./placement-wire.js";
import {
  loadCommonsResidents,
  loadLinkDestinations,
  performCommonsRetain,
  performCommonsShare,
} from "./share-wire.js";

interface InlineLinkDestination {
  linkId: string;
  vaultId: string;
  partyId: string;
  approved: boolean;
}

interface InlineCommonsResident {
  grantId: string;
  itemType: string;
  itemId: string;
  originItemId: string;
}

interface InlineCommonsShareResult extends Record<string, unknown> {
  grantId: string;
  claims: Array<{ partyId: string; claimToken: string }>;
}

/** The kit change-feed event shape (blueprints' ambient `CentraidChangeDetail`). */
interface InlineChangeDetail {
  tables?: string[];
  source?: string;
  intentId?: string;
  intentState?: string;
  ts?: number;
  /** Which mounted scope burst. Apps refetch only this one (issue #599). */
  scope?: string;
}

/** The replica surface one scope binding needs. */
export type InlineScopeSession = Pick<
  ReplicaShellSession,
  | "read"
  | "search"
  | "write"
  | "subscribe"
  | "pendingWrites"
  | "attentionWrites"
  | "dismissAttentionWrite"
  | "rowVersion"
>;

/**
 * One optimistic mutation an app's declared projection produced (issue #738).
 * The bridge forwards it verbatim into the replica write, which validates it
 * against the app's catalog and persists it on the durable intent — from then
 * on every read composes it via the coordinator's `overlayMutations` path.
 */
export interface InlineOptimisticMutation {
  op: "upsert" | "delete";
  entity: string;
  rowId: string;
  values?: Record<string, unknown>;
  /** Which consented purpose's shape to resolve; defaults to the app's. */
  purpose?: string;
  shapeId?: string;
}

/** One unsettled write from the durable outbox, reshaped for the app (issue
 * #738): the pending-write overlay engine rebuilds its rows from this list on
 * mount/reload, so visibility survives exactly as long as the outbox does. */
export interface InlinePendingWrite {
  intentId: string;
  action: string;
  state: "queued" | "sending" | "awaiting-change" | "parked";
  reason?: string;
  input: Record<string, unknown>;
  mutations: InlineOptimisticMutation[];
}

/** One settled write that did not execute and still awaits the member (issue
 * #738): denied, conflicted or failed. Durable, so the overlay engine can
 * rebuild the row — with its reason and (for a conflict) expected vs actual
 * versions — after a reload, instead of losing it with the scrubbed intent. */
export interface InlineAttentionWrite {
  intentId: string;
  action: string;
  status: "denied" | "conflict" | "failed";
  reason?: string;
  input: Record<string, unknown>;
  mutations: InlineOptimisticMutation[];
  conflict?: {
    entity: string;
    rowId: string;
    expectedVersion: number;
    actualVersion: number;
  };
  settledAt: string;
}

/** One row version an app hands `write({baseVersions})` as an optimistic
 * concurrency precondition (issue #738 P2). */
export interface InlineBaseVersion {
  entity: string;
  rowId: string;
  version: number;
  shapeId?: string;
}

/** One mounted scope: its shell-resolved descriptor and its replica session. */
export interface InlineScopeBinding {
  scope: InlineScope;
  session: InlineScopeSession;
}

/** One scope's answer in a `readAll` fan-out. Never throws — errors are data. */
export type InlineScopeRead<T> =
  | { scope: string; ok: true; data: T }
  | { scope: string; ok: false; error: { code?: string; message: string } };

/** Durable member-side overlay for a command waiting on its Commons steward.
 * `expired` (a parked intent that outlived its review window) and
 * `cancelled` (a member-initiated cancel) are settled states like `denied`
 * (issue #731 goal 2). */
export interface InlineCommonsIntent {
  intentId: string;
  grantId: string;
  actorPartyId: string;
  command: string;
  input: Record<string, unknown>;
  status:
    | "pending"
    | "parked"
    | "executed"
    | "denied"
    | "expired"
    | "cancelled";
  reason?: string;
  stewardLabel?: string;
  createdAt: string;
  settledAt?: string;
}

/** A People-directory identity available to the ceremony-free share sheet. */
export interface InlineShareTarget {
  partyId: string;
  label: string;
  /** Absent while the person is invited but has not joined with a vault. */
  vaultId?: string;
}

export interface InlineShareCircle {
  circleId: string;
  label: string;
  members: Array<{
    partyId: string;
    capability: "read" | "read+write";
    vaultId?: string;
  }>;
}

/** A refusal the app is expected to render, not a crash. */
export class InlineScopeError extends Error {
  constructor(
    readonly code: "SCOPE_READONLY" | "UNKNOWN_SCOPE",
    message: string
  ) {
    super(message);
    this.name = "InlineScopeError";
  }
}

export interface InlineCentraidClient {
  appId: string;
  /** Mounted scopes, primary (the member's own) first. */
  scopes: InlineScope[];
  read: <T = Record<string, unknown>>(opts: {
    query: string;
    input?: Record<string, unknown>;
    signal?: AbortSignal;
    scope?: string;
  }) => Promise<T>;
  readAll: <T = Record<string, unknown>>(opts: {
    query: string;
    input?: Record<string, unknown>;
    signal?: AbortSignal;
    /** Restrict the fan-out (e.g. "load more" hits only the horizon scopes). */
    scopes?: readonly string[];
  }) => Promise<InlineScopeRead<T>[]>;
  write: <T = unknown>(opts: {
    action: string;
    input?: Record<string, unknown>;
    intentId?: string;
    /** Declared pending projection for this write (issue #738) — persisted on
     * the durable intent and composed into every read until settlement. */
    optimistic?: InlineOptimisticMutation[];
    /** Optimistic-concurrency preconditions (issue #738 P2): the row versions
     * this write was composed against. The vault refuses with a `conflict`
     * outcome — expected vs actual — when any of them moved first. */
    baseVersions?: InlineBaseVersion[];
    signal?: AbortSignal;
    scope?: string;
  }) => Promise<T>;
  /** This app's unsettled writes from one scope's durable outbox (issue
   * #738) — the reload path for the pending-write overlay engine. */
  pendingWrites: (opts?: { scope?: string }) => Promise<InlinePendingWrite[]>;
  /** This app's settled writes that still await the member (issue #738) —
   * the reload path for denied/conflict/failed rows, which the outbox drops
   * on settle. */
  attentionWrites: (opts?: {
    scope?: string;
  }) => Promise<InlineAttentionWrite[]>;
  /** Forget one attention record, because the member discarded it or took it
   * for a retry, so a discarded row stays discarded across a reload. */
  dismissAttentionWrite: (opts: {
    intentId: string;
    scope?: string;
  }) => Promise<boolean>;
  /** The local replica's version for one row, for `write({baseVersions})`.
   * Undefined when this scope cannot address the row by an exposed key. */
  rowVersion: (opts: {
    entity: string;
    rowId: string;
    purpose?: string;
    scope?: string;
  }) => Promise<number | undefined>;
  /** Commands durably queued on this member seat while its steward is away. */
  commonsIntents: (opts?: {
    scope?: string;
    signal?: AbortSignal;
  }) => Promise<InlineCommonsIntent[]>;
  /** Cancel a durable Commons intent that has not executed yet (issue #731
   * goal 2). Idempotent and safe to race with the steward — the vault-side
   * guard only ever moves a still-open (`pending`/`parked`) intent to
   * `cancelled`; an intent the steward already settled comes back
   * unchanged, so the caller reads the real outcome off the result rather
   * than assuming the cancel won. */
  cancelCommonsIntent: (opts: {
    intentId: string;
    scope?: string;
  }) => Promise<{ status: string; cancelled: boolean }>;
  place: (opts: {
    linkToken: string;
    kind: "add" | "move";
    itemType:
      | "core.collection"
      | "core.content_item"
      | "core.document"
      | "docs.folder"
      | "locker.item"
      | "media.media_asset"
      | "tally.group";
    itemId: string;
    sourceVaultId: string;
    targetVaultId: string;
  }) => Promise<Record<string, unknown>>;
  /** Share a complete actable container into every joined member's vault. */
  share: (opts: {
    containerType:
      | "core.collection"
      | "core.content_item"
      | "core.document"
      | "docs.folder"
      | "locker.item"
      | "media.media_asset"
      | "tally.group";
    containerId: string;
    sourceVaultId: string;
    members: {
      partyId?: string;
      vaultId?: string;
      capability: "read" | "read+write";
    }[];
    circleId?: string;
  }) => Promise<InlineCommonsShareResult>;
  /** People-directory identities, joined to a vault only after acceptance. */
  shareTargets: () => Promise<InlineShareTarget[]>;
  /** Deliberately reusable named audiences. Implicit per-container circles
   * are excluded by construction. */
  shareCircles: () => Promise<InlineShareCircle[]>;
  commonsResidents: (actorVaultId?: string) => Promise<InlineCommonsResident[]>;
  retainCommonsItem: (opts: {
    actorVaultId: string;
    itemType: string;
    itemId: string;
  }) => Promise<{ retained: boolean; grantIds: string[] }>;
  /** The household's cross-vault links (#726 P6) — candidate share
   *  destinations beyond the member's own mounted scopes, co-hosted and
   *  remote alike (D3: locality is routing, not semantics). */
  links: () => Promise<InlineLinkDestination[]>;
  describe: () => Promise<unknown>;
  onChange: (cb: (detail: InlineChangeDetail) => void) => () => void;
  /** An authed `blob:` URL for a `/_vault/blobs/…` path in one scope. */
  blobUrl: (pathname: string, scope?: string) => Promise<string | null>;
}

/** Codes on which a failed local read escalates to the gateway tool route. */
const FALLBACK_CODES = new Set([
  "ONLINE_ONLY",
  "REPLICA_UNAVAILABLE",
  "REPLICA_NOT_READY",
  "REPLICA_REBOOTSTRAP_REQUIRED",
]);

function canFallbackOnline(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && FALLBACK_CODES.has(code);
}

/**
 * The escalation path when a local read cannot be answered from the replica.
 * It names the scope explicitly for the same reason the replica transport does
 * (see `fetchReplicaForScope`): without it the gateway answers for whichever
 * vault is FOCUSED, so a secondary scope would silently render the primary's
 * rows.
 */
async function gatewayRead(
  appId: string,
  query: string,
  input: Record<string, unknown> | undefined,
  scope: string | undefined
): Promise<unknown> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, appQueryPath(appId, query), {
    method: "POST",
    headers: {
      ...authHeaders(token, "application/json"),
      ...(scope ? { [VAULT_HEADER]: scope } : {}),
    },
    body: JSON.stringify({ input }),
  });
  return readJson<unknown>(res, `read ${query}`);
}

/** One stored optimistic mutation, in the shape apps read (no shapeId — the
 *  shell resolved that already when the write was admitted). */
function inlineMutation(mutation: {
  op: "upsert" | "delete";
  entity: string;
  rowId: string;
  values?: unknown;
}): InlineOptimisticMutation {
  return mutation.op === "upsert"
    ? {
        op: "upsert",
        entity: mutation.entity,
        rowId: mutation.rowId,
        values: mutation.values as Record<string, unknown>,
      }
    : { op: "delete", entity: mutation.entity, rowId: mutation.rowId };
}

/** Map one replica invalidation into the kit change-feed detail shape. */
function toChangeDetail(
  invalidation: ReplicaInvalidation,
  scope: string
): InlineChangeDetail {
  return {
    tables: invalidation.entity ? [invalidation.entity] : [],
    source: invalidation.source,
    ...(invalidation.intentId ? { intentId: invalidation.intentId } : {}),
    ...(invalidation.intentState
      ? { intentState: invalidation.intentState }
      : {}),
    ts: Date.now(),
    ...(scope ? { scope } : {}),
  };
}

function errorDetail(error: unknown): { code?: string; message: string } {
  const code = (error as { code?: unknown })?.code;
  return {
    ...(typeof code === "string" ? { code } : {}),
    message: error instanceof Error ? error.message : String(error),
  };
}

async function loadShareTargets(
  session: InlineScopeSession,
  ownVaultId: string
): Promise<InlineShareTarget[]> {
  const [peopleResult, vaultResult, links] = await Promise.all([
    session
      .read("people", {
        entity: "core.party",
        orderBy: { column: "display_name", dir: "asc" },
        limit: 500,
      })
      .catch(() => undefined),
    session
      .read("people", { entity: "core.vault", limit: 1 })
      .catch(() => undefined),
    loadLinkDestinations(ownVaultId),
  ]);
  const ownerPartyId = vaultResult?.rows[0]?.values["owner_party_id"];
  const linkedByParty = new Map(
    links.map((link) => [link.partyId, link.vaultId])
  );
  const targets = new Map<string, InlineShareTarget>();
  for (const row of peopleResult?.rows ?? []) {
    const partyId = row.values["party_id"];
    const displayName = row.values["display_name"];
    if (
      typeof partyId !== "string" ||
      partyId === ownerPartyId ||
      typeof displayName !== "string" ||
      !displayName.trim()
    )
      continue;
    const vaultId = linkedByParty.get(partyId);
    targets.set(partyId, {
      partyId,
      label: displayName,
      ...(vaultId ? { vaultId } : {}),
    });
  }
  for (const link of links) {
    if (targets.has(link.partyId)) continue;
    targets.set(link.partyId, {
      partyId: link.partyId,
      vaultId: link.vaultId,
      label: `Linked person ${link.vaultId.length > 10 ? `${link.vaultId.slice(0, 8)}…` : link.vaultId}`,
    });
  }
  return [...targets.values()];
}

async function loadShareCircles(
  session: InlineScopeSession,
  ownVaultId: string
): Promise<InlineShareCircle[]> {
  const [circles, members, groups, targets, vault] = await Promise.all([
    session
      .read("tally", { entity: "social.circle", limit: 500 })
      .catch(() => undefined),
    session
      .read("tally", { entity: "social.circle_member", limit: 2_000 })
      .catch(() => undefined),
    session
      .read("tally", { entity: "tally.group", limit: 500 })
      .catch(() => undefined),
    loadShareTargets(session, ownVaultId),
    session
      .read("people", { entity: "core.vault", limit: 1 })
      .catch(() => undefined),
  ]);
  // A current-owner Tally group is the shipped, deliberate named-circle
  // surface. Commons' implicit circles have no tally_group decorator; a
  // projected/foreign group has another owner. Neither can enter this picker.
  const ownerPartyId = vault?.rows[0]?.values["owner_party_id"];
  if (typeof ownerPartyId !== "string") return [];
  const ownedCircles = new Set(
    (circles?.rows ?? []).flatMap((row) => {
      const circleId = row.values["circle_id"];
      return typeof circleId === "string" &&
        row.values["owner_party_id"] === ownerPartyId
        ? [circleId]
        : [];
    })
  );
  const reusable = new Set(
    (groups?.rows ?? []).flatMap((row) => {
      const circleId = row.values["circle_id"];
      return typeof circleId === "string" && ownedCircles.has(circleId)
        ? [circleId]
        : [];
    })
  );
  const targetByParty = new Map(
    targets.map((target) => [target.partyId, target])
  );
  const byCircle = new Map<string, InlineShareCircle["members"]>();
  const incomplete = new Set<string>();
  for (const row of members?.rows ?? []) {
    const circleId = row.values["circle_id"];
    const partyId = row.values["party_id"];
    if (
      typeof circleId !== "string" ||
      !reusable.has(circleId) ||
      typeof partyId !== "string"
    )
      continue;
    if (partyId === ownerPartyId) continue;
    const target = targetByParty.get(partyId);
    // The steward is implicit in createCommonsGrant and is never submitted as
    // a member. Every other member must resolve exactly; a partial roster is
    // not offered as reusable.
    if (!target) {
      incomplete.add(circleId);
      continue;
    }
    const capability =
      row.values["capability"] === "read+write" ? "read+write" : "read";
    const list = byCircle.get(circleId) ?? [];
    list.push({
      partyId,
      capability,
      ...(target.vaultId ? { vaultId: target.vaultId } : {}),
    });
    byCircle.set(circleId, list);
  }
  return (circles?.rows ?? []).flatMap((row) => {
    const circleId = row.values["circle_id"];
    const label = row.values["name"];
    if (
      typeof circleId !== "string" ||
      !reusable.has(circleId) ||
      incomplete.has(circleId) ||
      typeof label !== "string" ||
      !label.trim()
    )
      return [];
    return [{ circleId, label, members: byCircle.get(circleId) ?? [] }];
  });
}

/**
 * The single-scope shape a pre-#599 caller passes. Its scope id is empty, which
 * every scope-addressed transport reads as "the ambient scope" — exactly the
 * behaviour that path had before.
 */
const AMBIENT_SCOPE: InlineScope = { id: "", label: "Library", canWrite: true };

export interface CreateInlineCentraidOptions {
  appId: string;
  queries: InlineAppModule["queries"];
  /** Mounted scopes, primary first. Mutually exclusive with `session`. */
  scopes?: readonly InlineScopeBinding[];
  /** Single-scope shorthand (pre-#599 callers and single-scope apps). */
  session?: InlineScopeSession;
  isOnline?: () => boolean;
}

function bindingsOf(
  options: CreateInlineCentraidOptions
): InlineScopeBinding[] {
  if (options.scopes && options.scopes.length > 0) return [...options.scopes];
  if (options.session)
    return [{ scope: AMBIENT_SCOPE, session: options.session }];
  throw new Error("An inline client needs at least one mounted scope");
}

/**
 * Live controls for a built client, kept OFF the client object so an app can
 * never reach them. The route host hydrates secondary scopes after first paint
 * (issue #599): the primary scope blocks the first render, every audience
 * arrives later through `addInlineScope`.
 */
interface InlineClientControls {
  add: (binding: InlineScopeBinding) => void;
}
const controls = new WeakMap<object, InlineClientControls>();

/**
 * Hydrate one more scope into an already-installed client. Returns false when
 * the object is not a client this module built. Existing `onChange` listeners
 * are extended to the new scope and then told it arrived, so an app refetches
 * exactly the scope that appeared rather than re-reading all of them.
 */
export function addInlineScope(
  client: unknown,
  binding: InlineScopeBinding
): boolean {
  const control =
    typeof client === "object" && client ? controls.get(client) : undefined;
  if (!control) return false;
  control.add(binding);
  return true;
}

/** Build the inline client for one app over N scopes. Writes nothing global. */
export function createInlineCentraidClient(
  options: CreateInlineCentraidOptions
): InlineCentraidClient {
  const { appId, queries } = options;
  const bindings = bindingsOf(options);
  const byId = new Map(bindings.map((binding) => [binding.scope.id, binding]));
  const primary = bindings[0]!;
  // Live `onChange` registrations, so a scope hydrated later still reaches
  // listeners that subscribed before it existed.
  const listeners = new Set<{
    cb: (detail: InlineChangeDetail) => void;
    stops: Map<string, () => void>;
  }>();
  const isOnline =
    options.isOnline ??
    (() =>
      typeof navigator === "undefined" ? true : navigator.onLine !== false);

  const bindingFor = (scope: string | undefined): InlineScopeBinding => {
    if (scope === undefined) return primary;
    const binding = byId.get(scope);
    if (!binding)
      throw new InlineScopeError("UNKNOWN_SCOPE", `${scope} is not mounted`);
    return binding;
  };

  const subscribe = (
    cb: (detail: InlineChangeDetail) => void,
    binding: InlineScopeBinding
  ): (() => void) =>
    binding.session.subscribe(appId, undefined, (invalidations) =>
      invalidations.forEach((invalidation) =>
        cb(toChangeDetail(invalidation, binding.scope.id))
      )
    );

  const readIn = async <T>(
    binding: InlineScopeBinding,
    opts: {
      query: string;
      input?: Record<string, unknown>;
      signal?: AbortSignal;
    }
  ): Promise<T> => {
    const module = queries[opts.query];
    if (!module) throw new Error(`Unknown query: ${opts.query}`);
    try {
      return (await runInlineQuery(module, {
        session: binding.session,
        appId,
        ...(opts.input ? { input: opts.input } : {}),
        isOnline,
        ...(opts.signal ? { signal: opts.signal } : {}),
      })) as T;
    } catch (error) {
      if (!canFallbackOnline(error)) throw error;
      return (await gatewayRead(
        appId,
        opts.query,
        opts.input,
        binding.scope.id
      )) as T;
    }
  };

  const client: InlineCentraidClient = {
    appId,
    // The SAME array the app holds: hydrating a scope pushes into it, so an
    // app that captured `client.scopes` sees the audience appear.
    scopes: bindings.map((binding) => binding.scope),

    // `async` deliberately: an unmounted-scope refusal must REJECT like every
    // other read failure, not throw synchronously out of the call site.
    async read<T>(opts: {
      query: string;
      input?: Record<string, unknown>;
      signal?: AbortSignal;
      scope?: string;
    }) {
      return readIn<T>(bindingFor(opts.scope), opts);
    },

    /**
     * Fan a query across scopes. Settled per scope: one audience being
     * unreachable, unmigrated, or denied must never blank the whole surface, so
     * its failure rides back as an entry the app can render beside live data.
     */
    async readAll<T>(opts: {
      query: string;
      input?: Record<string, unknown>;
      signal?: AbortSignal;
      scopes?: readonly string[];
    }) {
      const targets = opts.scopes
        ? bindings.filter((binding) => opts.scopes!.includes(binding.scope.id))
        : bindings;
      const settled = await Promise.allSettled(
        targets.map((binding) => readIn<T>(binding, opts))
      );
      return settled.map((result, index): InlineScopeRead<T> => {
        const scope = targets[index]!.scope.id;
        return result.status === "fulfilled"
          ? { scope, ok: true, data: result.value }
          : { scope, ok: false, error: errorDetail(result.reason) };
      });
    },

    async write<T>(opts: {
      action: string;
      input?: Record<string, unknown>;
      intentId?: string;
      optimistic?: InlineOptimisticMutation[];
      baseVersions?: InlineBaseVersion[];
      signal?: AbortSignal;
      scope?: string;
    }) {
      const binding = bindingFor(opts.scope);
      // A read-only audience is refused HERE rather than at the gateway: the
      // app gets a typed code it can turn into a disabled control, instead of a
      // 403 after the user already committed to the action.
      if (!binding.scope.canWrite) {
        throw new InlineScopeError(
          "SCOPE_READONLY",
          `You can view ${binding.scope.label}, but not add to it.`
        );
      }
      const result = await binding.session.write(appId, {
        action: opts.action,
        input: (opts.input ?? {}) as never,
        ...(opts.intentId ? { intentId: opts.intentId } : {}),
        // The app's declared pending projection (issue #738): validated and
        // persisted with the intent, so the queued row survives reload from
        // the outbox alone.
        ...(opts.optimistic && opts.optimistic.length > 0
          ? { optimistic: opts.optimistic as never }
          : {}),
        // The row versions the app composed this write against (issue #738
        // P2). Forwarded verbatim onto the durable intent and hashed with it,
        // so the vault can answer `conflict` with expected vs actual instead
        // of overwriting someone else's newer row.
        ...(opts.baseVersions && opts.baseVersions.length > 0
          ? { baseVersions: opts.baseVersions }
          : {}),
      });
      // Shape the intent outcome into the `VaultOutcome` the kit narrates: the
      // durable intentId is the app's `invocationId` (pending-add key), and any
      // handler output rides through unchanged. A conflict's expected-vs-actual
      // detail rides through too (issue #738 P2) — a conflict row must never
      // degrade to a generic transport error.
      const outcome = result as {
        intentId: string;
        status: string;
        reason?: string;
        output?: unknown;
        conflict?: unknown;
      };
      return {
        status: outcome.status,
        invocationId: outcome.intentId,
        ...(outcome.reason
          ? { reason: outcome.reason, message: outcome.reason }
          : {}),
        ...(outcome.output === undefined ? {} : { output: outcome.output }),
        ...(outcome.conflict === undefined
          ? {}
          : { conflict: outcome.conflict }),
      } as T;
    },

    async pendingWrites(opts) {
      const binding = bindingFor(opts?.scope);
      const pending = await binding.session.pendingWrites(appId);
      return pending.map((intent) => ({
        intentId: intent.intentId,
        action: intent.action,
        state: intent.state,
        ...(intent.reason === undefined ? {} : { reason: intent.reason }),
        input: (intent.input ?? {}) as Record<string, unknown>,
        mutations: intent.optimistic.map(inlineMutation),
      }));
    },

    async attentionWrites(opts) {
      const binding = bindingFor(opts?.scope);
      const records = await binding.session.attentionWrites(appId);
      return records.map((record) => ({
        intentId: record.intentId,
        action: record.action,
        status: record.status,
        ...(record.reason === undefined ? {} : { reason: record.reason }),
        input: (record.input ?? {}) as Record<string, unknown>,
        mutations: record.optimistic.map(inlineMutation),
        ...(record.conflict === undefined
          ? {}
          : {
              conflict: {
                entity: record.conflict.entity,
                rowId: record.conflict.rowId,
                expectedVersion: record.conflict.expectedVersion,
                actualVersion: record.conflict.actualVersion,
              },
            }),
        settledAt: record.settledAt,
      }));
    },

    async dismissAttentionWrite(opts) {
      const binding = bindingFor(opts.scope);
      return binding.session.dismissAttentionWrite(appId, opts.intentId);
    },

    async rowVersion(opts) {
      const binding = bindingFor(opts.scope);
      return binding.session.rowVersion(
        appId,
        opts.entity,
        opts.rowId,
        opts.purpose
      );
    },

    async commonsIntents(opts) {
      const binding = bindingFor(opts?.scope);
      if (!binding.scope.id) return [];
      const { baseUrl, token } = await auth();
      const response = await doFetch(
        baseUrl,
        `${ROUTES.gatewayCommons}/intents?actorVaultId=${encodeURIComponent(binding.scope.id)}`,
        {
          headers: authHeaders(token),
          ...(opts?.signal ? { signal: opts.signal } : {}),
        }
      );
      const payload = await readJson<{
        intents?: Array<{
          intentId: string;
          grantId: string;
          actorPartyId: string;
          command: string;
          inputJson: string;
          status: InlineCommonsIntent["status"];
          reason?: string | null;
          stewardLabel?: string | null;
          createdAt: string;
          settledAt?: string | null;
        }>;
      }>(response, "list commons intents");
      return (payload.intents ?? []).map((intent) => {
        let input: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(intent.inputJson);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            input = parsed as Record<string, unknown>;
        } catch {
          // A malformed historical row remains visible with an empty payload;
          // the overlay must not disappear merely because it cannot be drawn.
        }
        const stewardLabel = intent.stewardLabel ?? undefined;
        const reason =
          intent.reason ??
          (intent.status === "pending" || intent.status === "parked"
            ? `Waiting for ${stewardLabel || "the Commons steward"}.`
            : undefined);
        return {
          intentId: intent.intentId,
          grantId: intent.grantId,
          actorPartyId: intent.actorPartyId,
          command: intent.command,
          input,
          status: intent.status,
          ...(reason ? { reason } : {}),
          ...(stewardLabel ? { stewardLabel } : {}),
          createdAt: intent.createdAt,
          ...(intent.settledAt ? { settledAt: intent.settledAt } : {}),
        };
      });
    },

    async cancelCommonsIntent(opts) {
      const binding = bindingFor(opts.scope);
      if (!binding.scope.id) return { status: "pending", cancelled: false };
      const { baseUrl, token } = await auth();
      const response = await doFetch(
        baseUrl,
        `${ROUTES.gatewayCommons}/intents/${encodeURIComponent(opts.intentId)}/cancel`,
        {
          method: "POST",
          headers: authHeaders(token, "application/json"),
          body: JSON.stringify({ actorVaultId: binding.scope.id }),
        }
      );
      return readJson(response, "cancel commons intent");
    },

    async place(opts) {
      bindingFor(opts.sourceVaultId);
      const target = bindingFor(opts.targetVaultId);
      if (!target.scope.canWrite) {
        throw new InlineScopeError(
          "SCOPE_READONLY",
          `You can view ${target.scope.label}, but not add to it.`
        );
      }
      if (!isOnline())
        throw new Error(
          "Placement needs a gateway connection on web; the native app queues it offline."
        );
      const { baseUrl, token } = await auth();
      // The wire door is `/edges` now (#726 P2); place()'s signature/result
      // stay pre-#726-P2 (placement-wire.ts), so no caller needs an edit.
      const response = await doFetch(baseUrl, ROUTES.gatewayEdges, {
        method: "POST",
        headers: authHeaders(token, "application/json"),
        body: JSON.stringify({
          edgeId: opts.linkToken,
          originVaultId: opts.sourceVaultId,
          audienceVaultId: opts.targetVaultId,
          mode: "snapshot",
          kind: opts.kind,
          itemType: opts.itemType,
          itemIds: [opts.itemId],
          verbs: "read",
        }),
      });
      const edge = await readJson<Record<string, unknown>>(
        response,
        "place item"
      );
      return placementWireFromEdge(edge, opts);
    },

    async share(opts) {
      bindingFor(opts.sourceVaultId);
      if (!isOnline())
        throw new Error(
          "Sharing needs a gateway connection on web; the native app queues writes offline."
        );
      return performCommonsShare(await auth(), opts);
    },

    shareTargets() {
      return loadShareTargets(primary.session, primary.scope.id);
    },

    shareCircles() {
      return loadShareCircles(primary.session, primary.scope.id);
    },

    commonsResidents(actorVaultId = primary.scope.id) {
      bindingFor(actorVaultId);
      return auth().then((gatewayAuth) =>
        loadCommonsResidents(gatewayAuth, actorVaultId)
      );
    },

    retainCommonsItem(opts) {
      bindingFor(opts.actorVaultId);
      return auth().then((gatewayAuth) =>
        performCommonsRetain(gatewayAuth, opts)
      );
    },

    links() {
      return loadLinkDestinations(primary.scope.id);
    },

    describe() {
      // Manifests ship in the shell bundle; no inline app reads describe on the
      // render path today, so answer with an empty descriptor rather than a
      // network round-trip (issue #505 surface inventory).
      return Promise.resolve({ commands: [] });
    },

    onChange(cb) {
      const registration = { cb, stops: new Map<string, () => void>() };
      listeners.add(registration);
      for (const binding of bindings)
        registration.stops.set(binding.scope.id, subscribe(cb, binding));
      return () => {
        listeners.delete(registration);
        for (const stop of registration.stops.values()) stop();
      };
    },

    blobUrl(pathname, scope) {
      const id = scope ?? primary.scope.id;
      return authorizeBlobUrl(pathname, id || undefined);
    },
  };

  controls.set(client, {
    add(binding) {
      if (byId.has(binding.scope.id)) return;
      bindings.push(binding);
      byId.set(binding.scope.id, binding);
      client.scopes.push(binding.scope);
      for (const registration of listeners) {
        registration.stops.set(
          binding.scope.id,
          subscribe(registration.cb, binding)
        );
        // Announce the arrival on the same channel a burst uses, tagged with
        // the new scope — the app's existing per-scope refetch handles it, and
        // nothing has to re-read the scopes that were already painted.
        registration.cb({
          source: "scope-added",
          scope: binding.scope.id,
          ts: Date.now(),
        });
      }
    },
  });
  return client;
}

export interface InstallInlineCentraidOptions extends CreateInlineCentraidOptions {
  /** Test seam for the window the client is published on. */
  target?: { centraid?: unknown };
  /**
   * The client that was published. The route host keeps it so later scope
   * hydration extends THIS client rather than whatever is on `window` by then
   * (a remount installs its own).
   */
  onInstalled?: (client: InlineCentraidClient) => void;
}

/** Install `window.centraid` for one inline app mount; returns the teardown. */
export function installInlineCentraid(
  options: InstallInlineCentraidOptions
): () => void {
  const target = (options.target ?? (window as unknown)) as {
    centraid?: unknown;
  };
  const previous = target.centraid;
  const client = createInlineCentraidClient(options);
  target.centraid = client;
  options.onInstalled?.(client);
  return () => {
    // Only restore if we are still the installed client: a remount (a new scope
    // set) installs its own client first, and clobbering that with a stale
    // `previous` would leave the fresh mount without a client at all.
    if (target.centraid === client) target.centraid = previous;
  };
}
