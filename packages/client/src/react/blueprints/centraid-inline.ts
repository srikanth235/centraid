import { isAddressablePartyKind } from "@centraid/blueprints/apps/_shared/party-kind";
import { projectPendingWrite } from "@centraid/blueprints/apps/_shared/pending-overlay";
import type { PendingProjectionDeclaration } from "@centraid/blueprints/apps/_shared/pending-overlay";
// governance: allow-repo-hygiene file-size-limit (#731) the inline host bridge keeps query, write, sharing, Commons claim, resident-save, and replica invalidation doors in one security boundary.
import type {
  InlineAppModule,
  InlineScope,
} from "@centraid/blueprints/apps/inline-types";
import {
  appActionPath,
  appQueryPath,
  commonsIntentCancelPath,
  commonsIntentDecidePath,
  ROUTES,
} from "@centraid/core/protocol";

import {
  auth,
  authHeaders,
  doFetch,
  readJson,
  VAULT_HEADER,
} from "../../gateway-client-core.js";
import type { GatewayAuth } from "../../gateway-client-core.js";
import type {
  VaultImportBatch,
  VaultImportRow,
} from "../../gateway-client-vault-imports.js";
import type { ReplicaShellSession } from "../../replica/shell-session.js";
import type { ReplicaInvalidation } from "../../replica/types.js";
import { authorizeBlobText, authorizeBlobUrl } from "./blob-auth.js";
import { stageBlob, stageDerivative } from "./blob-staging.js";
import type { GrantBridge } from "./grant-seat.js";
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

interface InlineChangeDetail {
  tables?: string[];
  source?: string;
  intentId?: string;
  intentState?: string;
  ts?: number;
  scope?: string;
}

export type InlineScopeSession = Pick<
  ReplicaShellSession,
  "read" | "search" | "write" | "subscribe"
> &
  Partial<
    Pick<ReplicaShellSession, "discardPendingWrite" | "retryPendingWrite">
  >;

export interface InlineScopeBinding {
  scope: InlineScope;
  session: InlineScopeSession;
}

export type InlineScopeRead<T> =
  | { scope: string; ok: true; data: T }
  | { scope: string; ok: false; error: { code?: string; message: string } };

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

export interface InlineCommonsIntentDecision {
  intentId: string;
  grantId: string;
  decision: "approve" | "decline";
  status: InlineCommonsIntent["status"];
  decided: boolean;
  reason?: string;
  sequence?: number;
  receiptId: string;
}

export interface InlineImportStaged {
  batchId: string;
  kind: string;
  staged: Record<string, number>;
  total: number;
  unrouted: string[];
}

export interface InlineImportPublished {
  created: number;
  updated: number;
  skipped: number;
  failed: unknown[];
}

export interface InlineShareTarget {
  partyId: string;
  label: string;
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
    scopes?: readonly string[];
  }) => Promise<InlineScopeRead<T>[]>;
  write: <T = unknown>(opts: {
    action: string;
    input?: Record<string, unknown>;
    intentId?: string;
    signal?: AbortSignal;
    scope?: string;
    onlineOnly?: boolean;
  }) => Promise<T>;
  retryPendingWrite: (intentId: string, scope?: string) => Promise<boolean>;
  discardPendingWrite: (intentId: string, scope?: string) => Promise<boolean>;
  openApprovals?: () => void;
  openApp?: (appId: string, focus?: { taskId?: string }) => void;
  commonsIntents: (opts?: {
    scope?: string;
    signal?: AbortSignal;
  }) => Promise<InlineCommonsIntent[]>;
  cancelCommonsIntent: (opts: {
    intentId: string;
    scope?: string;
  }) => Promise<{ status: string; cancelled: boolean }>;
  decideCommonsIntent?: (opts: {
    intentId: string;
    decision: "approve" | "decline";
    reason?: string;
    scope?: string;
  }) => Promise<InlineCommonsIntentDecision>;
  stageImport?: (file: File) => Promise<InlineImportStaged>;
  importBatches?: () => Promise<VaultImportBatch[]>;
  importRows?: (batchId: string) => Promise<VaultImportRow[]>;
  publishImport?: (batchId: string) => Promise<InlineImportPublished>;
  discardImport?: (batchId: string) => Promise<{ receiptId: string }>;
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
  shareTargets: () => Promise<InlineShareTarget[]>;
  quickAddPerson: (opts: {
    name: string;
  }) => Promise<{ partyId: string; label: string }>;
  shareCircles: () => Promise<InlineShareCircle[]>;
  commonsResidents: (actorVaultId?: string) => Promise<InlineCommonsResident[]>;
  retainCommonsItem: (opts: {
    actorVaultId: string;
    itemType: string;
    itemId: string;
  }) => Promise<{ retained: boolean; grantIds: string[] }>;
  links: () => Promise<InlineLinkDestination[]>;
  grants: GrantBridge;
  describe: () => Promise<unknown>;
  onChange: (cb: (detail: InlineChangeDetail) => void) => () => void;
  blobUrl: (pathname: string, scope?: string) => Promise<string | null>;
  blobText: (pathname: string, scope?: string) => Promise<string | null>;
  stageBlob: typeof stageBlob;
  stageDerivative: typeof stageDerivative;
}

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

const EVERYTHING = "*";

function toChangeDetail(
  invalidation: ReplicaInvalidation,
  scope: string
): InlineChangeDetail {
  const named =
    invalidation.entity && invalidation.entity !== EVERYTHING
      ? [invalidation.entity]
      : [];
  return {
    tables: named,
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
  const ownerPartyId = vaultResult?.rows[0]?.values["self_party_id"];
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
      !displayName.trim() ||
      !isAddressablePartyKind(row.values["kind"])
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
      label: link.label ?? "Linked person",
    });
  }
  return [...targets.values()];
}

const QUICK_ADD_CADENCE_DAYS = 30;

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
  const ownerPartyId = vault?.rows[0]?.values["self_party_id"];
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

const AMBIENT_SCOPE: InlineScope = { id: "", label: "Library", canWrite: true };

export interface CreateInlineCentraidOptions {
  appId: string;
  pendingProjection?: PendingProjectionDeclaration;
  queries: InlineAppModule["queries"];
  scopes?: readonly InlineScopeBinding[];
  session?: InlineScopeSession;
  isOnline?: () => boolean;
  onOpenApprovals?: () => void;
  onOpenApp?: (appId: string, focus?: { taskId?: string }) => void;
}

function bindingsOf(
  options: CreateInlineCentraidOptions
): InlineScopeBinding[] {
  if (options.scopes && options.scopes.length > 0) return [...options.scopes];
  if (options.session)
    return [{ scope: AMBIENT_SCOPE, session: options.session }];
  throw new Error("An inline client needs at least one mounted scope");
}

interface InlineClientControls {
  add: (binding: InlineScopeBinding) => void;
}
const controls = new WeakMap<object, InlineClientControls>();

function lazyGrantBridge(getAuth: () => Promise<GatewayAuth>): GrantBridge {
  let pending: Promise<GrantBridge> | undefined;
  const loaded = (): Promise<GrantBridge> =>
    (pending ??= import("./grant-seat.js").then((mod) =>
      mod.queuedGrantBridge(getAuth)
    ));
  return {
    subjects: async () => (await loaded()).subjects(),
    forParty: async (partyId) => (await loaded()).forParty(partyId),
    forAudience: async (kind, id) => (await loaded()).forAudience(kind, id),
    forSubject: async (subjectType, subjectId) =>
      (await loaded()).forSubject(subjectType, subjectId),
    create: async (request) => (await loaded()).create(request),
    revoke: async (grantId) => (await loaded()).revoke(grantId),
  };
}

let pendingVaultImports:
  | Promise<typeof import("../../gateway-client-vault-imports.js")>
  | undefined;
function lazyVaultImports(): Promise<
  typeof import("../../gateway-client-vault-imports.js")
> {
  return (pendingVaultImports ??=
    import("../../gateway-client-vault-imports.js"));
}

const MAX_IMPORT_BYTES = 128 * 1024 * 1024;

const TEXT_IMPORT_EXTENSIONS =
  /\.(?:csv|tsv|txt|json|ndjson|md|mdown|vcf|ics|eml|mbox)$/iu;

function base64Of(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunk)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  return btoa(binary);
}

async function importBodyFor(
  file: File
): Promise<{ filename: string; text?: string; base64?: string }> {
  if (file.size > MAX_IMPORT_BYTES)
    throw new InlineScopeError(
      "INVALID_INPUT",
      `${file.name} is ${file.size} bytes; imports stop at ${MAX_IMPORT_BYTES}.`
    );
  const filename = file.name;
  if (TEXT_IMPORT_EXTENSIONS.test(filename))
    return { filename, text: await file.text() };
  return {
    filename,
    base64: base64Of(new Uint8Array(await file.arrayBuffer())),
  };
}

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

export function createInlineCentraidClient(
  options: CreateInlineCentraidOptions
): InlineCentraidClient {
  const { appId, queries, pendingProjection } = options;
  const bindings = bindingsOf(options);
  const byId = new Map(bindings.map((binding) => [binding.scope.id, binding]));
  const primary = bindings[0]!;
  const listeners = new Set<{
    cb: (detail: InlineChangeDetail) => void;
    stops: Map<string, () => void>;
  }>();
  const isOnline =
    options.isOnline ??
    (() =>
      typeof navigator === "undefined" ? true : navigator.onLine !== false);

  const requireOnline = (what: string): void => {
    if (!isOnline())
      throw new Error(
        `${what} needs a gateway connection; it is never queued offline.`
      );
  };

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
    scopes: bindings.map((binding) => binding.scope),

    async read<T>(opts: {
      query: string;
      input?: Record<string, unknown>;
      signal?: AbortSignal;
      scope?: string;
    }) {
      return readIn<T>(bindingFor(opts.scope), opts);
    },

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
      if (!binding.scope.canWrite) {
        throw new InlineScopeError(
          "SCOPE_READONLY",
          `${binding.scope.label} is read-only here.`
        );
      }
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

    ...(options.onOpenApp ? { openApp: options.onOpenApp } : {}),

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
          // Intentionally empty.
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
        commonsIntentCancelPath(encodeURIComponent(opts.intentId)),
        {
          method: "POST",
          headers: authHeaders(token, "application/json"),
          body: JSON.stringify({ actorVaultId: binding.scope.id }),
        }
      );
      return readJson(response, "cancel commons intent");
    },

    async decideCommonsIntent(opts) {
      const binding = bindingFor(opts.scope);
      if (!binding.scope.id)
        throw new InlineScopeError(
          "INVALID_INPUT",
          "Answering a Commons request needs a named vault scope."
        );
      const { baseUrl, token } = await auth();
      const response = await doFetch(
        baseUrl,
        commonsIntentDecidePath(encodeURIComponent(opts.intentId)),
        {
          method: "POST",
          headers: authHeaders(token, "application/json"),
          body: JSON.stringify({
            actorVaultId: binding.scope.id,
            decision: opts.decision,
            ...(opts.reason ? { reason: opts.reason } : {}),
          }),
        }
      );
      return readJson(response, "decide commons intent");
    },

    async stageImport(file) {
      requireOnline("Importing a file");
      const body = await importBodyFor(file);
      return (await lazyVaultImports()).vaultImportStage(body);
    },

    async importBatches() {
      return (await lazyVaultImports()).vaultImportsList();
    },

    async importRows(batchId) {
      return (await lazyVaultImports()).vaultImportRows(batchId);
    },

    async publishImport(batchId) {
      requireOnline("Publishing an import");
      return (await lazyVaultImports()).vaultImportPublish(batchId);
    },

    async discardImport(batchId) {
      requireOnline("Discarding an import");
      return (await lazyVaultImports()).vaultImportDiscard(batchId);
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
      if (!isOnline())
        throw new Error(
          "Adding a person needs a gateway connection on web; add them from the People app on the native seat."
        );
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

    grants: lazyGrantBridge(auth),

    describe() {
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
  target?: { centraid?: unknown };
  onInstalled?: (client: InlineCentraidClient) => void;
}

const publishedClients = new WeakSet<object>();

function isPublishedClient(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && publishedClients.has(value)
  );
}

export function installInlineCentraid(
  options: InstallInlineCentraidOptions
): () => void {
  const target = (options.target ?? (window as unknown)) as {
    centraid?: unknown;
  };
  const client = createInlineCentraidClient(options);
  const previous = target.centraid;
  publishedClients.add(client);
  target.centraid = client;
  options.onInstalled?.(client);
  return () => {
    if (target.centraid !== client) return;
    target.centraid = isPublishedClient(previous) ? undefined : previous;
  };
}
