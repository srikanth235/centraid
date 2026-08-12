import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";
import { KeyStore } from "@centraid/vault";

import { EnrollmentStore } from "./enrollment-store.js";
import { GatewayDatabase } from "./gateway-db.js";
import { PairingTicketStore } from "./pairing-store.js";
import { ProvisionPerson } from "./provision-person.js";
import type { ProvisionPersonStep } from "./provision-person.js";
import { openVaultRegistry } from "./vault-registry.js";
import type { VaultRegistry } from "./vault-registry.js";

const cleanups: Array<() => void | Promise<void>> = [];
const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe(ProvisionPerson, () => {
  afterEach(async () => {
    await Promise.all(
      cleanups
        .splice(0)
        .toReversed()
        .map((cleanup) => cleanup())
    );
  });

  async function open(
    onStep?: (point: "before" | "after", step: ProvisionPersonStep) => void
  ): Promise<{
    provision: ProvisionPerson;
    database: GatewayDatabase;
    vaults: VaultRegistry;
    enrollments: EnrollmentStore;
    tickets: PairingTicketStore;
    keysDir: string;
  }> {
    const dataDir = await tempDir("provision-person-");
    const database = GatewayDatabase.open(dataDir);
    const enrollments = EnrollmentStore.open(database);
    const tickets = PairingTicketStore.open(database);
    const keysDir = path.join(dataDir, "keys");
    const keys = new KeyStore(keysDir);
    const vaults = openVaultRegistry({
      rootDir: path.join(dataDir, "vault"),
      logger,
      keyStore: keys,
    });
    cleanups.push(async () => {
      vaults.stop();
      database.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    return {
      provision: new ProvisionPerson({
        database,
        enrollments,
        tickets,
        vaults,
        keys,
        now: () => 1_800_000_000_000,
        onStep,
      }),
      database,
      vaults,
      enrollments,
      tickets,
      keysDir,
    };
  }

  test("replaying one operation returns one person, vault, ownership, and ticket", async () => {
    const fixture = await open();
    const input = {
      operationId: "add-priya-1",
      ownerLabel: "Priya",
      vaultName: "Priya's vault",
      ttlMs: 15 * 60_000,
    };
    const first = fixture.provision.run(input);
    const replay = fixture.provision.run(input);

    expect(replay).toStrictEqual(first);
    expect(fixture.enrollments.owners.list()).toHaveLength(1);
    expect(fixture.vaults.list().map((vault) => vault.vaultId)).toStrictEqual([
      first.vaultId,
    ]);
    expect(fixture.enrollments.owners.ownerOf(first.vaultId)).toBe(
      first.ownerId
    );
    expect(
      fixture.tickets.listActive().map((ticket) => ticket.ticketId)
    ).toStrictEqual([first.ticketId]);
    expect(
      (
        fixture.database.db
          .prepare("SELECT state FROM provision_person_operations")
          .get() as { state: string }
      ).state
    ).toBe("executed");
  });

  test("one operation id cannot be replayed with different input", async () => {
    const fixture = await open();
    fixture.provision.run({
      operationId: "add-person-fixed",
      ownerLabel: "Priya",
      vaultName: "Priya's vault",
      ttlMs: 900_000,
    });
    expect(() =>
      fixture.provision.run({
        operationId: "add-person-fixed",
        ownerLabel: "Someone else",
        vaultName: "Another vault",
        ttlMs: 900_000,
      })
    ).toThrow(/another provisioning request/u);
    expect(fixture.enrollments.owners.list()).toHaveLength(1);
    expect(fixture.vaults.list()).toHaveLength(1);
  });

  test.each(
    (
      [
        "plan",
        "secret",
        "vault",
        "owner",
        "ownership",
        "ticket",
        "finalize",
      ] as const
    ).flatMap((step) => ["before", "after"].map((point) => ({ point, step })))
  )(
    "resumes after a crash $point the $step durable step without duplicates",
    async ({ point, step }) => {
      let injected = false;
      const fixture = await open((at, current) => {
        if (!injected && at === point && current === step) {
          injected = true;
          throw new Error(`crash ${point} ${step}`);
        }
      });
      const input = {
        operationId: `failure-${point}-${step}`,
        ownerLabel: "Priya",
        vaultName: "Priya's vault",
        ttlMs: 15 * 60_000,
      };
      expect(() => fixture.provision.run(input)).toThrow(
        `crash ${point} ${step}`
      );
      const resumed = fixture.provision.run(input);
      const replay = fixture.provision.run(input);

      expect(replay).toStrictEqual(resumed);
      expect(fixture.enrollments.owners.list()).toHaveLength(1);
      expect(fixture.vaults.list()).toHaveLength(1);
      expect(fixture.enrollments.owners.ownerOf(resumed.vaultId)).toBe(
        resumed.ownerId
      );
      expect(fixture.tickets.listActive()).toHaveLength(1);
      await expect(fs.readdir(fixture.keysDir)).resolves.toHaveLength(3);
      expect(
        fixture.database.db
          .prepare(
            "SELECT operation_id, state FROM provision_person_operations"
          )
          .all()
      ).toMatchObject([{ operation_id: input.operationId, state: "executed" }]);
    }
  );
});
