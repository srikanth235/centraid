import type {
  ReplicaCoverage,
  ReplicaInvalidation,
  ReplicaReadWireResult,
  ReplicaSearchWireResult,
} from "@centraid/client/replica/native";

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
  onScopePulled?: (vaultId: string) => void;
  /** Fires once per revoked scope, with the label the purge is about to erase. */
  onScopeRevoked?: (scope: MountedReplicaScope) => void;
  /**
   * Closes that vault's SQLite handle and deletes its file family, after the
   * purge has emptied it. Injected because the provider owns the driver handles
   * and the filesystem; this class owns only WHEN a replica file stops being an
   * asset — which is revocation, and never cap eviction.
   */
  reclaimRevokedReplica?: (scope: MountedReplicaScope) => void | Promise<void>;
}

/**
 * What one `pullScopes()` pass actually obtained, per scope.
 *
 * A pull can end three ways and the UI must not conflate them: it landed
 * (freshness may advance), it was tried and did not land (the gateway is not
 * answering), or the member's transfer rules refused the radio before anything
 * was asked. Only `pulled` may stamp freshness — docs/mobile-offline.md:
 * freshness advances only after that source successfully pulls.
 */
export interface ReplicaPullOutcome {
  pulled: readonly string[];
  stalled: readonly string[];
  /** The transfer rules said no, so no scope was dialled at all. */
  policyBlocked: boolean;
}

/**
 * Every state a row of this device's outbox can be in — the intent outbox's
 * own states, plus the placement outbox's. Closed on purpose: the pending
 * surface's copy switch is exhaustive over it, so a new state cannot reach a
 * member as a raw engine word.
 */
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

/** Per-scope durable coverage, plus the conservative aggregate over it. */
export interface MultiVaultReplicaStatus {
  coverage: ReplicaCoverage;
  scopes: ReadonlyArray<{ vaultId: string; coverage: ReplicaCoverage }>;
}

/** App-facing facade: unified reads/search, explicitly scoped writes. */
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
    this.#onScopePulled = options.onScopePulled;
    this.#onScopeRevoked = options.onScopeRevoked;
    this.#reclaimRevokedReplica = options.reclaimRevokedReplica;
  }

  read(
    appId: string,
    request: NativeReadRequest
  ): Promise<ReplicaReadWireResult> {
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

  /**
   * Out of room is a device fact, not a per-vault one: one parked scope means
   * the phone has no space, so the whole mounted plane reports it and the
   * screens draw the `out of room` state once.
   */
  get storageFull(): boolean {
    return [...this.#sessions.values()].some((session) => session.storageFull);
  }

  /** Space was freed on the phone: unpark every scope that stopped for it. */
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

  /** `MobileReplicaSession`'s boolean: did this pass obtain anything at all. */
  async pullNow(): Promise<boolean> {
    const outcome = await this.pullScopes();
    return outcome.pulled.length > 0;
  }

  /**
   * The pass the UI reads. The transfer-rule check is asked HERE, once, rather
   * than left to each `NativeReplicaSession.pullNow()` — those answer `false`
   * for a blocked pull and a silent gateway alike, and a caller that cannot
   * tell them apart renders "Updated just now" over a pull that never happened.
   */
  async pullScopes(): Promise<ReplicaPullOutcome> {
    const vaultIds = [...this.#sessions.keys()];
    if (!(await this.#isNetworkWorkAllowed()))
      return { pulled: [], stalled: vaultIds, policyBlocked: true };
    const results = await Promise.all(
      [...this.#sessions].map(async ([vaultId, session]) => {
        const contactedGateway = await session.pullNow();
        // Only a landed pull may stamp freshness for its scope.
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

  /**
   * Durable coverage per mounted scope. The aggregate is conservative — one
   * partial source keeps the whole mounted read plane partial — matching the
   * reader's own `min` rule, so a fast source cannot make a half-backfilled
   * library look complete (docs/mobile-offline.md).
   */
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
    // Announce BEFORE the purge: the label is about to be erased along with
    // the rows, and a member told nothing is a vault that vanished silently.
    if (scope) this.#onScopeRevoked?.(scope);
    try {
      this.#reader.revokeScope(vaultId);
    } finally {
      // Purge empties the tables in place and keeps the handle, so the file is
      // still at full size for a vault this phone may never see again. Detach
      // (above) then purge then reclaim is the only order in which the delete
      // cannot race a live reader or writer.
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
      // Intent ids are globally unique. Stop at the one outbox that owns it.
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

  /**
   * The device's whole outbox, as one list the pending surface renders.
   *
   * `label` stays `${appId}: ${action}` because seats parse it for their own
   * rows (apps/tally/tally-view-model.ts). `appId` and `action` travel beside
   * it so the shell's own sheet can present the act in words instead, and the
   * conflict versions, `attempts` and `enqueuedAt` travel with the row because
   * a member deciding between Retry and Discard needs all three
   * (docs/mobile-offline.md: the client retains reason and both versions until
   * the member edits, retries or discards).
   */
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
        .toReversed();
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
