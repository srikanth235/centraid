import type {
  ReplicaCoverage,
  ReplicaInvalidation,
  ReplicaSearchWireResult,
} from "@centraid/client/replica/native";

import type { MountedReadResult } from "./mounted-read-scoping";
import type {
  MultiVaultReplicaReader,
  MountedReplicaScope,
  PlacementIntent,
  PlacementRecord,
} from "./multi-vault-reader";
import type {
  MobileReplicaSession,
  NativeReplicaSession,
  NativeReadRequest,
  NativeSearchRequest,
  NativeWriteInput,
  NativeWriteResult,
} from "./native-session";
import type { CommonsIntent, CommonsRecord } from "./placement-transport";

export interface MultiVaultSessionOptions {
  reader: MultiVaultReplicaReader;
  sessions: Map<string, NativeReplicaSession>;
  scopes: readonly MountedReplicaScope[];
  focusedVaultId: () => string | undefined;
  createId: () => string;
  sendPlacement: (input: PlacementIntent) => Promise<PlacementRecord>;
  sendCommons?: (input: CommonsIntent) => Promise<CommonsRecord>;
  isConnected: () => boolean;
  isNetworkWorkAllowed?: () => Promise<boolean>;
  isRowSyncAllowed?: () => Promise<boolean>;
  onScopePulled?: (vaultId: string) => void;
  onScopeRevoked?: (scope: MountedReplicaScope) => void;
  reclaimRevokedReplica?: (scope: MountedReplicaScope) => void | Promise<void>;
}

export interface ReplicaPullOutcome {
  pulled: readonly string[];
  stalled: readonly string[];
  policyBlocked: boolean;
}

export type PendingChangeStatus =
  | "queued"
  | "sending"
  | "in-flight"
  | "awaiting-change"
  | "parked"
  | "denied"
  | "conflict"
  | "failed"
  | "executed";

export interface MultiVaultReplicaStatus {
  coverage: ReplicaCoverage;
  scopes: ReadonlyArray<{ vaultId: string; coverage: ReplicaCoverage }>;
}

export class MultiVaultReplicaSession implements MobileReplicaSession {
  readonly #reader: MultiVaultReplicaReader;
  readonly #sessions: Map<string, NativeReplicaSession>;
  #scopes: MountedReplicaScope[];
  readonly #focusedVaultId: () => string | undefined;
  readonly #createId: () => string;
  readonly #sendPlacement: (input: PlacementIntent) => Promise<PlacementRecord>;
  readonly #sendCommons: (input: CommonsIntent) => Promise<CommonsRecord>;
  readonly #isConnected: () => boolean;
  readonly #isNetworkWorkAllowed: () => Promise<boolean>;
  readonly #isRowSyncAllowed: () => Promise<boolean>;
  readonly #onScopePulled: ((vaultId: string) => void) | undefined;
  readonly #onScopeRevoked: ((scope: MountedReplicaScope) => void) | undefined;
  readonly #reclaimRevokedReplica:
    | ((scope: MountedReplicaScope) => void | Promise<void>)
    | undefined;
  #placementDrain: Promise<void> | undefined;

  constructor(options: MultiVaultSessionOptions) {
    this.#reader = options.reader;
    this.#sessions = options.sessions;
    this.#scopes = [...options.scopes];
    this.#focusedVaultId = options.focusedVaultId;
    this.#createId = options.createId;
    this.#sendPlacement = options.sendPlacement;
    this.#sendCommons =
      options.sendCommons ??
      (() =>
        Promise.reject(new Error("Sharing is unavailable in this session.")));
    this.#isConnected = options.isConnected;
    this.#isNetworkWorkAllowed =
      options.isNetworkWorkAllowed ?? (() => Promise.resolve(true));
    this.#isRowSyncAllowed =
      options.isRowSyncAllowed ?? this.#isNetworkWorkAllowed;
    this.#onScopePulled = options.onScopePulled;
    this.#onScopeRevoked = options.onScopeRevoked;
    this.#reclaimRevokedReplica = options.reclaimRevokedReplica;
  }

  read(appId: string, request: NativeReadRequest): Promise<MountedReadResult> {
    return this.#reader.read(appId, request);
  }

  search(
    appId: string,
    request: NativeSearchRequest
  ): Promise<ReplicaSearchWireResult> {
    return this.#reader.search(appId, request);
  }

  write(appId: string, input: NativeWriteInput): Promise<NativeWriteResult> {
    const focused = this.#focusedVaultId();
    const target =
      (focused &&
      this.#scopes.some((scope) => scope.vaultId === focused && scope.canWrite)
        ? focused
        : this.#scopes.find((scope) => scope.canWrite)?.vaultId) ??
      this.#scopes[0]?.vaultId;
    if (!target) throw new Error("No mounted replica scope accepts writes");
    return this.writeTo(target, appId, input);
  }

  writeTo(
    vaultId: string,
    appId: string,
    input: NativeWriteInput
  ): Promise<NativeWriteResult> {
    const scope = this.#scopes.find(
      (candidate) => candidate.vaultId === vaultId
    );
    if (!scope) throw new Error(`Vault ${vaultId} is not mounted`);
    if (!scope.canWrite)
      throw new Error(`${scope.label} is read-only for this member`);
    const session = this.#sessions.get(vaultId);
    if (!session) throw new Error(`Vault ${vaultId} has no write session`);
    return session.write(appId, input);
  }

  subscribe(
    appId: string,
    listener: (invalidations: readonly ReplicaInvalidation[]) => void
  ): () => void {
    const unsubscribes = [...this.#sessions.values()].map((session) =>
      session.subscribe(appId, listener)
    );
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }

  scopes(): readonly MountedReplicaScope[] {
    return this.#scopes;
  }

  get storageFull(): boolean {
    return [...this.#sessions.values()].some((session) => session.storageFull);
  }

  resumeAfterStorageFull(): void {
    for (const session of this.#sessions.values())
      session.resumeAfterStorageFull();
  }

  notifyReachable(): void {
    for (const session of this.#sessions.values()) session.notifyReachable();
    void this.flushPlacements();
  }

  updateGatewayBase(baseUrl: string): void {
    for (const session of this.#sessions.values())
      session.updateGatewayBase(baseUrl);
  }

  async pullNow(): Promise<boolean> {
    const outcome = await this.pullScopes();
    return outcome.pulled.length > 0;
  }

  async pullScopes(): Promise<ReplicaPullOutcome> {
    const vaultIds = [...this.#sessions.keys()];
    if (!(await this.#isRowSyncAllowed()))
      return { pulled: [], stalled: vaultIds, policyBlocked: true };
    const results = await Promise.all(
      [...this.#sessions].map(async ([vaultId, session]) => {
        const contactedGateway = await session.pullNow();
        if (contactedGateway) this.#onScopePulled?.(vaultId);
        return { vaultId, contactedGateway: contactedGateway === true };
      })
    );
    return {
      pulled: results
        .filter((result) => result.contactedGateway)
        .map((result) => result.vaultId),
      stalled: results
        .filter((result) => !result.contactedGateway)
        .map((result) => result.vaultId),
      policyBlocked: false,
    };
  }

  async status(): Promise<MultiVaultReplicaStatus> {
    const scopes = await Promise.all(
      [...this.#sessions].map(async ([vaultId, session]) => ({
        vaultId,
        coverage: (await session.status()).coverage ?? ("partial" as const),
      }))
    );
    return {
      coverage:
        scopes.length > 0 &&
        scopes.every((scope) => scope.coverage === "complete")
          ? "complete"
          : "partial",
      scopes,
    };
  }

  async revokeScope(vaultId: string): Promise<void> {
    const session = this.#sessions.get(vaultId);
    const scope = this.#scopes.find(
      (candidate) => candidate.vaultId === vaultId
    );
    this.#sessions.delete(vaultId);
    this.#scopes = this.#scopes.filter((entry) => entry.vaultId !== vaultId);
    if (scope) this.#onScopeRevoked?.(scope);
    try {
      this.#reader.revokeScope(vaultId);
    } finally {
      await session?.purge();
      if (scope) await this.#reclaimRevokedReplica?.(scope);
    }
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.#sessions.values()].map((session) => session.close())
    );
    this.#reader.close();
  }

  async discardPendingWrite(
    intentId: string,
    vaultId?: string
  ): Promise<boolean> {
    const candidates = vaultId
      ? [this.#sessions.get(vaultId)].filter(
          (session): session is NativeReplicaSession => Boolean(session)
        )
      : [...this.#sessions.values()];
    for (const session of candidates) {
      // oxlint-disable-next-line no-await-in-loop
      if (await session.discardPendingWrite(intentId)) return true;
    }
    return false;
  }

  async retryPendingWrite(
    intentId: string,
    vaultId?: string
  ): Promise<NativeWriteResult | undefined> {
    const candidates = vaultId
      ? [this.#sessions.get(vaultId)].filter(
          (session): session is NativeReplicaSession => Boolean(session)
        )
      : [...this.#sessions.values()];
    for (const session of candidates) {
      // oxlint-disable-next-line no-await-in-loop
      const replacement = await session.retryPendingWrite(intentId);
      if (replacement) return replacement;
    }
    return undefined;
  }

  async pendingChanges(): Promise<
    Array<{
      id: string;
      vaultId: string;
      vaultLabel: string;
      status: PendingChangeStatus;
      label: string;
      appId?: string;
      action?: string;
      reason?: string;
      attempts?: number;
      enqueuedAt?: string;
      expectedVersion?: number;
      actualVersion?: number;
      kind: "replica" | "placement";
    }>
  > {
    const replica = (
      await Promise.all(
        [...this.#sessions].map(async ([vaultId, session]) => {
          const scope = this.#scopes.find((item) => item.vaultId === vaultId)!;
          return (await session.pendingChanges()).map((item) => ({
            id: item.intentId,
            vaultId,
            vaultLabel: scope.label,
            status: item.status,
            label: `${item.appId}: ${item.action}`,
            appId: item.appId,
            action: item.action,
            ...(item.reason ? { reason: item.reason } : {}),
            ...("attempts" in item ? { attempts: item.attempts } : {}),
            ...("enqueuedAt" in item && item.enqueuedAt
              ? { enqueuedAt: item.enqueuedAt }
              : {}),
            ...("expectedVersion" in item &&
            item.expectedVersion !== undefined &&
            item.actualVersion !== undefined
              ? {
                  expectedVersion: item.expectedVersion,
                  actualVersion: item.actualVersion,
                }
              : {}),
            kind: "replica" as const,
          }));
        })
      )
    ).flat();
    const placements = this.#reader.placements().map((item) => ({
      id: item.linkToken,
      vaultId: item.targetVaultId,
      vaultLabel:
        this.#scopes.find((scope) => scope.vaultId === item.targetVaultId)
          ?.label ?? "Vault",
      status: item.status,
      label: `${item.kind === "move" ? "Move" : "Add"} ${item.itemType}`,
      ...(item.reason ? { reason: item.reason } : {}),
      kind: "placement" as const,
    }));
    return [...placements, ...replica];
  }

  async cancelPendingChange(
    id: string,
    vaultId: string,
    kind: "replica" | "placement"
  ): Promise<boolean> {
    return kind === "placement"
      ? this.cancelPlacement(id)
      : ((await this.#sessions.get(vaultId)?.cancelPendingChange(id)) ?? false);
  }

  dismissPendingChange(
    id: string,
    vaultId: string,
    kind: "replica" | "placement"
  ): void {
    if (kind === "placement") this.dismissPlacement(id);
    else this.#sessions.get(vaultId)?.dismissAttention(id);
  }

  async place(
    input: Omit<PlacementIntent, "linkToken"> & { linkToken?: string }
  ): Promise<PlacementRecord> {
    const record = this.#reader.enqueuePlacement({
      ...input,
      linkToken: input.linkToken ?? this.#createId(),
    });
    if (this.#isConnected()) await this.flushPlacements();
    return this.#reader.placement(record.linkToken) ?? record;
  }

  share(input: CommonsIntent): Promise<CommonsRecord> {
    if (!this.#isConnected()) {
      return Promise.reject(new Error("Sharing needs a gateway connection."));
    }
    return this.#sendCommons(input);
  }

  placements(): PlacementRecord[] {
    return this.#reader.placements();
  }

  cancelPlacement(linkToken: string): boolean {
    return this.#reader.cancelPlacement(linkToken);
  }

  dismissPlacement(linkToken: string): void {
    this.#reader.dismissPlacement(linkToken);
  }

  async flushPlacements(): Promise<void> {
    if (!this.#isConnected()) return;
    if (!(await this.#isNetworkWorkAllowed())) return;
    if (this.#placementDrain) return this.#placementDrain;
    this.#placementDrain = (async () => {
      const pending = this.#reader
        .placements()
        .filter(
          (record) =>
            record.status === "queued" ||
            record.status === "parked" ||
            record.status === "in-flight"
        )
        // oxlint-disable-next-line unicorn/no-array-reverse -- (#905) fresh .filter() temporary; governance: allow-no-unjustified-suppressions in-place by design
        .reverse();
      await Promise.all(
        pending.map(async (record) => {
          this.#reader.updatePlacement({ ...record, status: "in-flight" });
          try {
            this.#reader.updatePlacement(
              await this.#sendPlacement(withoutState(record))
            );
          } catch (error) {
            const status =
              error &&
              typeof error === "object" &&
              "placementStatus" in error &&
              (error.placementStatus === "denied" ||
                error.placementStatus === "failed")
                ? error.placementStatus
                : "parked";
            this.#reader.updatePlacement({
              ...record,
              status,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        })
      );
    })().finally(() => {
      this.#placementDrain = undefined;
    });
    return this.#placementDrain;
  }
}

function withoutState(record: PlacementRecord): PlacementIntent {
  return {
    linkToken: record.linkToken,
    kind: record.kind,
    itemType: record.itemType,
    itemId: record.itemId,
    sourceVaultId: record.sourceVaultId,
    targetVaultId: record.targetVaultId,
  };
}
