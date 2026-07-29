import type {
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

export interface MultiVaultSessionOptions {
  reader: MultiVaultReplicaReader;
  sessions: Map<string, NativeReplicaSession>;
  scopes: readonly MountedReplicaScope[];
  focusedVaultId: () => string | undefined;
  createId: () => string;
  sendPlacement: (input: PlacementIntent) => Promise<PlacementRecord>;
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
    this.#isConnected = options.isConnected;
    this.#isNetworkWorkAllowed =
      options.isNetworkWorkAllowed ?? (() => Promise.resolve(true));
    this.#onScopePulled = options.onScopePulled;
  }

  read(
    appId: string,
    request: NativeReadRequest
  ): Promise<ReplicaReadWireResult> {
    return Promise.resolve(this.#reader.read(appId, request));
  }

  search(
    appId: string,
    request: NativeSearchRequest
  ): Promise<ReplicaSearchWireResult> {
    return Promise.resolve(this.#reader.search(appId, request));
  }

  write(appId: string, input: NativeWriteInput): Promise<NativeWriteResult> {
    const focused = this.#focusedVaultId();
    const target =
      (focused &&
      this.#scopes.some(
        (scope) => scope.vaultId === focused && scope.role !== "read"
      )
        ? focused
        : this.#scopes.find((scope) => scope.role !== "read")?.vaultId) ??
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
    if (scope.role === "read")
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
