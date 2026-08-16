import { projectPendingWrite } from "@centraid/blueprints/apps/_shared/pending-overlay";
import type { PendingProjectionDeclaration } from "@centraid/blueprints/apps/_shared/pending-overlay";
// governance: allow-repo-hygiene file-size-limit (#731) the inline host bridge keeps query, write, sharing, Commons claim, resident-save, and replica invalidation doors in one security boundary.
import type {
  InlineAppModule,
  InlineScope,
} from "@centraid/blueprints/apps/inline-types";
// The inline `window.centraid` — the app client every blueprint app talks to.
// Backed by the shell replica session: reads run the app's query modules locally
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
import { appActionPath, appQueryPath, ROUTES } from "@centraid/core/protocol";

import {
  auth,
  authHeaders,
  doFetch,
  readJson,
  VAULT_HEADER,
} from "../../gateway-client-core.js";
import type { ReplicaShellSession } from "../../replica/shell-session.js";
import type { ReplicaInvalidation } from "../../replica/types.js";
import { authorizeBlobText, authorizeBlobUrl } from "./blob-auth.js";
import { stageBlob, stageDerivative } from "./blob-staging.js";
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
  /** The linked vault's own name from the vault directory (#750), or null. */
  label: string | null;
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
  "read" | "search" | "write" | "subscribe"
> &
  Partial<
    Pick<ReplicaShellSession, "discardPendingWrite" | "retryPendingWrite">
  >;

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
  status: "queued" | "parked" | "executed" | "denied" | "expired" | "cancelled";
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
    readonly code: "INVALID_INPUT" | "SCOPE_READONLY" | "UNKNOWN_SCOPE",
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
    signal?: AbortSignal;
    scope?: string;
    /** Bypass every replica/outbox path for sealed or otherwise non-durable input. */
    onlineOnly?: boolean;
  }) => Promise<T>;
  retryPendingWrite: (intentId: string, scope?: string) => Promise<boolean>;
  discardPendingWrite: (intentId: string, scope?: string) => Promise<boolean>;
  /** Leave the app for the shell-owned owner/steward review inbox. */
  openApprovals?: () => void;
  /** Commands durably queued on this member seat while its steward is away. */
  commonsIntents: (opts?: {
    scope?: string;
    signal?: AbortSignal;
  }) => Promise<InlineCommonsIntent[]>;
  /** Cancel a durable Commons intent that has not executed yet (issue #731
   * goal 2). Idempotent and safe to race with the steward — the vault-side
   * guard only ever moves a still-open (`queued`/`parked`) intent to
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
      | "media.asset"
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
      | "media.asset"
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
  /** Mint a People person inline from the ShareSheet. Online-only: resolves
   *  only with a real, settled party id — never a pending overlay id. */
  quickAddPerson: (opts: {
    name: string;
  }) => Promise<{ partyId: string; label: string }>;
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
  /** Authed text bytes, without a CSP-governed second fetch of a blob URL. */
  blobText: (pathname: string, scope?: string) => Promise<string | null>;
  /** Stream a File into the vault's blob CAS (see blob-staging.ts). */
  stageBlob: typeof stageBlob;
  /** Submit a typed derivative contribution against a staged parent. */
  stageDerivative: typeof stageDerivative;
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

/**
 * Invoke an explicitly online-only action without ever presenting its payload
 * to a replica session. The served iframe bridge has the same policy boundary;
 * keeping it here prevents the inline seat from durably queueing sealed input.
 */
async function gatewayAction(
  appId: string,
  action: string,
  input: Record<string, unknown> | undefined,
  scope: string | undefined,
  signal: AbortSignal | undefined
): Promise<unknown> {
  const { baseUrl, token } = await auth();
  const response = await doFetch(baseUrl, appActionPath(appId, action), {
    method: "POST",
    headers: {
      ...authHeaders(token, "application/json"),
      ...(scope ? { [VAULT_HEADER]: scope } : {}),
    },
    body: JSON.stringify({ input }),
    ...(signal ? { signal } : {}),
  });
  return readJson(response, `write ${action}`);
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
      // The directory's own name for that vault (#750). When it truly has
      // none, say so honestly — a truncated vault id is not a person's name
      // and never read as one.
      label: link.label ?? "Linked person",
    });
  }
  return [...targets.values()];
}

/** The default check-in cadence a person gets when People mints them without
 * the member choosing one, matching the People screen's own default. */
const QUICK_ADD_CADENCE_DAYS = 30;

/**
 * The party id a quick-add write actually settled on, or a throw. Only an
 * `executed` intent has a real identity behind it: `queued`/`parked` are still
 * waiting on a steward, and `denied`/`expired`/`cancelled` never happened at
 * all. A `pending:` id is the offline overlay's placeholder, never a person —
 * returning one would put a nonexistent identity into a share.
 */
export function settledPartyIdFromOutcome(outcome: unknown): string {
  const settled = outcome as {
    status?: unknown;
    output?: { party_id?: unknown };
  } | null;
  if (settled?.status !== "executed")
    throw new Error(
      `Adding a person did not complete (${String(settled?.status ?? "no outcome")}).`
    );
  const partyId = settled.output?.party_id;
  if (typeof partyId !== "string" || !partyId || partyId.startsWith("pending:"))
    throw new Error("Adding a person did not return a settled identity.");
  return partyId;
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
  pendingProjection?: PendingProjectionDeclaration;
  queries: InlineAppModule["queries"];
  /** Mounted scopes, primary first. Mutually exclusive with `session`. */
  scopes?: readonly InlineScopeBinding[];
  /** Single-scope shorthand (pre-#599 callers and single-scope apps). */
  session?: InlineScopeSession;
  isOnline?: () => boolean;
  /** Shell navigation stays injected; blueprints never import shell routing. */
  onOpenApprovals?: () => void;
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
  const { appId, queries, pendingProjection } = options;
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
        ...(binding.scope.id ? { scopeId: binding.scope.id } : {}),
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
      signal?: AbortSignal;
      scope?: string;
      onlineOnly?: boolean;
    }) {
      const binding = bindingFor(opts.scope);
      // A read-only audience is refused HERE rather than at the gateway: the
      // app gets a typed code it can turn into a disabled control, instead of a
      // 403 after the user already committed to the action.
      if (!binding.scope.canWrite) {
        throw new InlineScopeError(
          "SCOPE_READONLY",
          `${binding.scope.label} is read-only here.`
        );
      }
      // Sealed inputs must never cross the durable session boundary. Network
      // failure is returned to the app and cannot fall back to queueing.
      if (opts.onlineOnly === true) {
        return (await gatewayAction(
          appId,
          opts.action,
          opts.input,
          binding.scope.id,
          opts.signal
        )) as T;
      }
      const intentId = opts.intentId ?? globalThis.crypto.randomUUID();
      const projected = projectPendingWrite(pendingProjection, {
        appId,
        action: opts.action,
        input: opts.input ?? {},
        intentId,
      });
      const result = await binding.session.write(appId, {
        action: opts.action,
        input: (opts.input ?? {}) as never,
        intentId,
        ...(projected.optimistic.length > 0
          ? { optimistic: projected.optimistic }
          : {}),
        ...(projected.baseVersions
          ? { baseVersions: projected.baseVersions }
          : {}),
      });
      // Shape the intent outcome into the `VaultOutcome` the kit narrates: the
      // durable intentId is the app's `invocationId` (pending-add key), and any
      // handler output rides through unchanged.
      const outcome = result as {
        intentId: string;
        status: string;
        reason?: string;
        output?: unknown;
      };
      return {
        status: outcome.status,
        invocationId: outcome.intentId,
        ...(outcome.reason
          ? { reason: outcome.reason, message: outcome.reason }
          : {}),
        ...(outcome.output === undefined ? {} : { output: outcome.output }),
      } as T;
    },

    async retryPendingWrite(intentId, scope) {
      const retry = bindingFor(scope).session.retryPendingWrite;
      if (!retry) return false;
      return (
        (await retry.call(bindingFor(scope).session, intentId)) !== undefined
      );
    },

    async discardPendingWrite(intentId, scope) {
      const discard = bindingFor(scope).session.discardPendingWrite;
      if (!discard) return false;
      return discard.call(bindingFor(scope).session, intentId);
    },

    ...(options.onOpenApprovals
      ? { openApprovals: options.onOpenApprovals }
      : {}),

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
          (intent.status === "queued" || intent.status === "parked"
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
      if (!binding.scope.id) return { status: "queued", cancelled: false };
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
          `${target.scope.label} is read-only here.`
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

    async quickAddPerson(opts) {
      const name = opts.name.trim();
      if (!name)
        throw new InlineScopeError(
          "INVALID_INPUT",
          "A person needs a name before they can be added."
        );
      // No offline queue for this one: the sheet needs the settled party id
      // right now to name a member, and an overlay id names nobody.
      if (!isOnline())
        throw new Error(
          "Adding a person needs a gateway connection on web; add them from the People app on the native seat."
        );
      // Written under the PEOPLE app's identity from whichever app is
      // embedding the sheet — the same cross-app-id path `loadShareTargets`
      // reads the roster over, so no app manifest grows a People grant.
      const outcome = await primary.session.write("people", {
        action: "add-person",
        input: {
          display_name: name,
          cadence_days: QUICK_ADD_CADENCE_DAYS,
        } as never,
        intentId: globalThis.crypto.randomUUID(),
      });
      return { partyId: settledPartyIdFromOutcome(outcome), label: name };
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

    blobText(pathname, scope) {
      const id = scope ?? primary.scope.id;
      return authorizeBlobText(pathname, id || undefined);
    },

    // The upload half of the same door. Passed through rather than bound to
    // the primary scope: `stageFileBytes({scope})` names the mounted scope the
    // bytes belong to, and defaulting it here would quietly stage an
    // audience's upload into the member's own CAS (issue #599).
    stageBlob,
    stageDerivative,
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

const installStacks = new WeakMap<
  object,
  { stack: unknown[]; original: unknown }
>();

/** Install `window.centraid` for one inline app mount; returns the teardown. */
export function installInlineCentraid(
  options: InstallInlineCentraidOptions
): () => void {
  const target = (options.target ?? (window as unknown)) as {
    centraid?: unknown;
  };
  const client = createInlineCentraidClient(options);
  const held = installStacks.get(target) ?? {
    stack: [],
    original: target.centraid,
  };
  held.stack.push(client);
  installStacks.set(target, held);
  target.centraid = client;
  options.onInstalled?.(client);
  return () => {
    // Scope-set remounts install the new client before the old mount's
    // cleanup runs. A last-writer `previous` restore then puts the stale
    // client back on `window` after the live mount unmounts (Home), so
    // goHome's `window.centraid === undefined` poll hangs. The stack is the
    // live installs; teardown publishes the remaining top, or the original.
    const current = installStacks.get(target);
    if (!current) return;
    const index = current.stack.lastIndexOf(client);
    if (index >= 0) current.stack.splice(index, 1);
    target.centraid = current.stack.at(-1) ?? current.original;
    if (current.stack.length === 0) installStacks.delete(target);
  };
}
