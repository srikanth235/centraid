import type {
  OptimisticMutation,
  ReplicaConflict,
  ReplicaInvalidation,
  ReplicaReadWireResult,
  ReplicaSearchWireResult,
} from "@centraid/client/replica/native";

import { composeMountedOverlay } from "./multi-vault-overlay";
import type { ScopedOverlay } from "./multi-vault-overlay";
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
  }

  /**
   * The mounted read, composed with every mounted vault's unsettled writes.
   *
   * The reader answers from the ATTACHed databases and never passes through a
   * coordinator, so the overlay each per-vault session applies to its own
   * reads has to be applied here too — otherwise a queued write is durable and
   * invisible (issue #738). Composition is pure and read-path only: nothing
   * here can evict, settle, or reorder the outbox.
   */
  async read(
    appId: string,
    request: NativeReadRequest
  ): Promise<ReplicaReadWireResult> {
    const result = await this.#reader.read(appId, request);
    return composeMountedOverlay(
      result,
      request,
      await this.mountedOverlays(appId, request.entity)
    );
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
   * Each mounted vault's unsettled writes for one entity, grouped by the shape
   * they were admitted against. A shape id is never compared across vaults:
   * the same app is a different shape in every vault, and an overlay only ever
   * applies to the vault whose outbox holds it.
   */
  private async mountedOverlays(
    appId: string,
    entity: string
  ): Promise<ScopedOverlay[]> {
    const perVault = await Promise.all(
      [...this.#sessions].map(async ([vaultId, session]) => {
        const scope = this.#scopes.find((item) => item.vaultId === vaultId);
        if (!scope) return [];
        const byShape = new Map<string, OptimisticMutation[]>();
        for (const mutation of await session.overlayMutations(appId, entity)) {
          const group = byShape.get(mutation.shapeId);
          if (group) group.push(mutation);
          else byShape.set(mutation.shapeId, [mutation]);
        }
        return [...byShape].flatMap(([shapeId, mutations]) => {
          const schema = session.entitySchema(shapeId, entity);
          return schema ? [{ scope, schema, mutations }] : [];
        });
      })
    );
    return perVault.flat();
  }

  notifyReachable(): void {
    for (const session of this.#sessions.values()) session.notifyReachable();
    void this.flushPlacements();
  }

  updateGatewayBase(baseUrl: string): void {
    for (const session of this.#sessions.values())
      session.updateGatewayBase(baseUrl);
  }

  async pullNow(): Promise<void> {
    await Promise.all(
      [...this.#sessions].map(async ([vaultId, session]) => {
        const contactedGateway = await session.pullNow();
        if (contactedGateway) this.#onScopePulled?.(vaultId);
      })
    );
  }

  async revokeScope(vaultId: string): Promise<void> {
    const session = this.#sessions.get(vaultId);
    this.#sessions.delete(vaultId);
    this.#scopes = this.#scopes.filter((scope) => scope.vaultId !== vaultId);
    try {
      this.#reader.revokeScope(vaultId);
    } finally {
      await session?.purge();
    }
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.#sessions.values()].map((session) => session.close())
    );
    this.#reader.close();
  }

  async pendingChanges(): Promise<
    Array<{
      id: string;
      vaultId: string;
      vaultLabel: string;
      status: string;
      label: string;
      reason?: string;
      kind: "replica" | "placement";
      appId?: string;
      rowIds?: string[];
      action?: string;
      input?: Record<string, unknown>;
      conflict?: ReplicaConflict;
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
            ...(item.reason ? { reason: item.reason } : {}),
            kind: "replica" as const,
            appId: item.appId,
            // The action name and journaled payload, so a durable attention
            // row can be retried under a fresh intent id (issue #738) — the
            // same fields the outbox rows already had via `label`, now named.
            action: item.action,
            // Present only while the write is still unsettled: the rows it put
            // on screen, which is what a list joins its pending chip against.
            ...("rowIds" in item ? { rowIds: item.rowIds } : {}),
            ...("input" in item && item.input !== undefined
              ? { input: item.input as Record<string, unknown> }
              : {}),
            ...("conflict" in item && item.conflict !== undefined
              ? { conflict: item.conflict }
              : {}),
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

  async dismissPendingChange(
    id: string,
    vaultId: string,
    kind: "replica" | "placement"
  ): Promise<void> {
    if (kind === "placement") {
      this.dismissPlacement(id);
      return;
    }
    // Awaited so the caller refreshes AFTER the durable record is gone; a
    // refresh that races the delete redraws the row it just discarded.
    await this.#sessions.get(vaultId)?.dismissAttention(id);
  }

  /**
   * A fresh intent id for a retry (issue #738): the sync-status sheet is
   * device-global and has no per-app write wrapper to mint one through
   * `write`'s own id resolution, and a retry's action/input are deliberately
   * identical to the attempt that just failed, so they must not coalesce
   * onto its id (`NativeReplicaSession.mintIntentId`).
   */
  mintIntentId(vaultId: string): string {
    const session = this.#sessions.get(vaultId);
    if (!session) throw new Error(`Vault ${vaultId} has no write session`);
    return session.mintIntentId();
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
