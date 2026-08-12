import { createHash, randomUUID } from "node:crypto";

import { uuidv7 } from "@centraid/vault";
import type { KeyStore } from "@centraid/vault";

import type { EnrollmentStore } from "./enrollment-store.js";
import type { GatewayDatabase } from "./gateway-db.js";
import type { PairingTicketStore } from "./pairing-store.js";
import type { VaultRegistry } from "./vault-registry.js";

interface ProvisionPersonRow {
  operation_id: string;
  request_hash: string;
  state: ProvisionPersonState;
  owner_id: string;
  vault_id: string;
  ticket_id: string;
  secret_key: string;
  expires_at: number;
  created_at: string;
  updated_at: string;
}

type ProvisionPersonState =
  | "planned"
  | "secret-ready"
  | "vault-ready"
  | "owner-ready"
  | "ownership-ready"
  | "ticket-ready"
  | "executed";

export type ProvisionPersonStep =
  | "plan"
  | "secret"
  | "vault"
  | "owner"
  | "ownership"
  | "ticket"
  | "finalize";

const STATE_ORDER: readonly ProvisionPersonState[] = [
  "planned",
  "secret-ready",
  "vault-ready",
  "owner-ready",
  "ownership-ready",
  "ticket-ready",
  "executed",
];

export interface ProvisionedPerson {
  ownerId: string;
  ownerLabel: string;
  vaultId: string;
  vaultName: string;
  ticketId: string;
  secret: string;
  expiresAt: number;
}

function operationConflict(operationId: string): Error {
  return Object.assign(
    new Error(
      `operation ${operationId} already names another provisioning request`
    ),
    { name: "ProvisionOperationConflictError" }
  );
}

/**
 * Explicitly resumable person provisioning across filesystem vault creation,
 * gateway principals, ownership, and a one-time ticket. Stable ids are
 * planned before the fallible filesystem step; replay resumes those ids and
 * never creates a second person or vault (#750).
 */
export class ProvisionPerson {
  constructor(
    private readonly deps: {
      database: GatewayDatabase;
      enrollments: EnrollmentStore;
      tickets: PairingTicketStore;
      vaults: VaultRegistry;
      keys: KeyStore;
      now?: () => number;
      /** Deterministic crash seam used by failure-injection tests. */
      onStep?: (point: "before" | "after", step: ProvisionPersonStep) => void;
    }
  ) {}

  run(input: {
    operationId: string;
    ownerLabel: string;
    vaultName: string;
    ttlMs: number;
  }): ProvisionedPerson {
    const operationId = input.operationId.trim();
    const ownerLabel = input.ownerLabel.trim();
    const vaultName = input.vaultName.trim();
    if (!operationId || operationId.length > 200)
      throw new Error("provisioning operationId must be a non-empty string");
    if (!ownerLabel || !vaultName)
      throw new Error("provisioning labels must not be empty");
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          operationId,
          ownerLabel,
          vaultName,
          ttlMs: input.ttlMs,
        })
      )
      .digest("hex");
    this.step("before", "plan");
    let row = this.plan({
      operationId,
      requestHash,
      ttlMs: input.ttlMs,
    });
    this.step("after", "plan");
    if (row.request_hash !== requestHash) throw operationConflict(operationId);
    this.step("before", "secret");
    const secretBytes = this.atLeast(row.state, "secret-ready")
      ? this.deps.keys.load(row.secret_key)
      : this.deps.keys.loadOrCreate(row.secret_key);
    if (!secretBytes)
      throw new Error("provisioning ticket secret is missing after creation");
    if (!this.atLeast(row.state, "secret-ready"))
      row = this.advance(row, "secret-ready");
    this.step("after", "secret");
    const secret = secretBytes.toString("base64url");

    this.step("before", "vault");
    if (!this.atLeast(row.state, "vault-ready")) {
      this.deps.vaults.createWithId(row.vault_id, vaultName);
      row = this.advance(row, "vault-ready");
    }
    this.step("after", "vault");

    this.step("before", "owner");
    if (!this.atLeast(row.state, "owner-ready")) {
      row = this.advanceInTransaction(row, "owner-ready", () => {
        this.deps.enrollments.owners.createKnownWithinTransaction(
          row.owner_id,
          ownerLabel
        );
      });
    }
    this.step("after", "owner");

    this.step("before", "ownership");
    if (!this.atLeast(row.state, "ownership-ready")) {
      row = this.advanceInTransaction(row, "ownership-ready", () => {
        this.deps.enrollments.owners.setOwner(row.vault_id, row.owner_id);
      });
    }
    this.step("after", "ownership");

    this.step("before", "ticket");
    if (!this.atLeast(row.state, "ticket-ready")) {
      row = this.advanceInTransaction(row, "ticket-ready", () => {
        this.deps.tickets.mintKnownWithinTransaction({
          ticketId: row.ticket_id,
          secret,
          invitation: { ownerId: row.owner_id, vaultIds: [row.vault_id] },
          expiresAt: row.expires_at,
          createdAt: row.created_at,
        });
      });
    }
    this.step("after", "ticket");

    this.step("before", "finalize");
    if (row.state !== "executed") row = this.advance(row, "executed");
    this.step("after", "finalize");
    return {
      ownerId: row.owner_id,
      ownerLabel,
      vaultId: row.vault_id,
      vaultName,
      ticketId: row.ticket_id,
      secret,
      expiresAt: row.expires_at,
    };
  }

  private plan(input: {
    operationId: string;
    requestHash: string;
    ttlMs: number;
  }): ProvisionPersonRow {
    return this.deps.database.transaction(() => {
      const existing = this.get(input.operationId);
      if (existing) return existing;
      const nowMs = this.now();
      const now = new Date(nowMs).toISOString();
      this.deps.database.run(
        `INSERT INTO provision_person_operations (
           operation_id, request_hash, state, owner_id, vault_id, ticket_id,
           secret_key, expires_at, created_at, updated_at
         ) VALUES (?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?)`,
        input.operationId,
        input.requestHash,
        randomUUID(),
        uuidv7({ msecs: nowMs }),
        randomUUID(),
        `provision-${createHash("sha256").update(input.operationId).digest("hex")}.secret`,
        nowMs + input.ttlMs,
        now,
        now
      );
      return this.get(input.operationId)!;
    });
  }

  private get(operationId: string): ProvisionPersonRow | undefined {
    return this.deps.database.db
      .prepare(
        "SELECT * FROM provision_person_operations WHERE operation_id = ?"
      )
      .get(operationId) as ProvisionPersonRow | undefined;
  }

  private atLeast(
    current: ProvisionPersonState,
    expected: ProvisionPersonState
  ): boolean {
    return STATE_ORDER.indexOf(current) >= STATE_ORDER.indexOf(expected);
  }

  private advance(
    row: ProvisionPersonRow,
    state: ProvisionPersonState
  ): ProvisionPersonRow {
    return this.deps.database.transaction(() =>
      this.advanceWithinTransaction(row, state)
    );
  }

  private advanceInTransaction(
    row: ProvisionPersonRow,
    state: ProvisionPersonState,
    act: () => void
  ): ProvisionPersonRow {
    return this.deps.database.transaction(() => {
      act();
      return this.advanceWithinTransaction(row, state);
    });
  }

  private advanceWithinTransaction(
    row: ProvisionPersonRow,
    state: ProvisionPersonState
  ): ProvisionPersonRow {
    if (STATE_ORDER.indexOf(state) !== STATE_ORDER.indexOf(row.state) + 1)
      throw new Error(
        `illegal provisioning transition ${row.state} -> ${state}`
      );
    this.deps.database.run(
      `UPDATE provision_person_operations SET state = ?, updated_at = ?
        WHERE operation_id = ? AND state = ?`,
      state,
      new Date(this.now()).toISOString(),
      row.operation_id,
      row.state
    );
    return this.get(row.operation_id)!;
  }

  private step(point: "before" | "after", step: ProvisionPersonStep): void {
    this.deps.onStep?.(point, step);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}
