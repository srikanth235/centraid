/**
 * PEOPLE AND AGENDA ON A PHONE AT YEAR-3 VOLUME (#922 E2).
 *
 * Both screens read whole entities: People holds a roster read plus its tags,
 * concepts and dates; Agenda holds eleven, one per layer of a day. Until this
 * lane every one of those reads said `acceptTruncation: true` — "the default
 * window is fine" — and the default is 1,000. At the year-3 roster of 5,000
 * people that is a screen the member counts and believes, and at 5,000 events
 * it is a calendar with four fifths of the year missing.
 *
 * So the reads declare `MOBILE_ENTITY_READ_WINDOW` (5,000) and this rig is the
 * proof that the declaration is survivable: the whole page comes back, and the
 * cost of the read is proportional to the ANSWER, not to the library — the
 * statement count is the same at 5,000 rows as the mounted-reader budget
 * measures at 520 (`apps/mobile/src/lib/replica/reader-statement-budget.test.ts`).
 *
 * VOLUME TABLE (year-3, two mounted vaults — a member and one household):
 *   core.party              5,000 per vault
 *   people.profile          5,000 per vault
 *   core.event              5,000 per vault
 *   schedule.attendee       5,000 per vault
 *
 * Assertions are catastrophe bounds. The load-bearing claims are the ROW COUNT
 * (the window is honoured) and the STATEMENT COUNT (constant in library size);
 * the milliseconds are printed for the receipt, and gated only loosely because
 * a shared CI box is not a phone.
 */
import path from "node:path";

import { describe, expect, test } from "vitest";

import { ReplicaSqliteStore } from "@centraid/client/replica/native";
import type {
  ReplicaBindValue,
  ReplicaRow,
} from "@centraid/client/replica/native";
import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { MultiVaultReplicaReader } from "../../apps/mobile/src/lib/replica/multi-vault-reader";
import { NodeSqliteDriver } from "../../apps/mobile/src/lib/replica/node-sqlite-driver";
import { MOBILE_ENTITY_READ_WINDOW } from "../../apps/mobile/src/lib/replica/offline-budgets";

const ROWS = 5_000;
const SCOPES = ["personal", "family"] as const;

class CountingDriver extends NodeSqliteDriver {
  readonly statements: string[] = [];

  override run(
    sql: string,
    parameters: readonly ReplicaBindValue[] = []
  ): void {
    this.statements.push(sql);
    super.run(sql, parameters);
  }

  override all<T extends object>(
    sql: string,
    parameters: readonly ReplicaBindValue[] = []
  ): T[] {
    this.statements.push(sql);
    return super.all<T>(sql, parameters);
  }

  override allAsync<T extends object>(
    sql: string,
    parameters: readonly ReplicaBindValue[] = []
  ): Promise<T[]> {
    this.statements.push(sql);
    return super.allAsync<T>(sql, parameters);
  }
}

interface Seeded {
  entity: string;
  primaryKey: string;
  columns: string[];
  row: (id: string, index: number) => ReplicaRow;
}

const PEOPLE: Seeded[] = [
  {
    entity: "core.party",
    primaryKey: "party_id",
    columns: ["party_id", "display_name", "kind"],
    row: (id, index) => ({
      party_id: id,
      display_name: `Person ${index}`,
      kind: "person",
    }),
  },
  {
    entity: "people.profile",
    primaryKey: "profile_id",
    columns: ["profile_id", "party_id", "cadence_days", "deleted_at"],
    row: (id, index) => ({
      profile_id: id,
      party_id: id,
      cadence_days: 30 + (index % 90),
      deleted_at: null,
    }),
  },
];

const AGENDA: Seeded[] = [
  {
    entity: "core.event",
    primaryKey: "event_id",
    columns: ["event_id", "calendar_id", "summary", "dtstart"],
    row: (id, index) => ({
      event_id: id,
      calendar_id: "cal-1",
      summary: `Event ${index}`,
      dtstart: new Date(1_760_000_000_000 + index * 3_600_000).toISOString(),
    }),
  },
  {
    entity: "schedule.attendee",
    primaryKey: "__centraid_row_id",
    columns: ["__centraid_row_id", "event_id", "party_id", "partstat"],
    row: (id, index) => ({
      __centraid_row_id: id,
      event_id: id,
      party_id: `party-${index}`,
      partstat: "needs-action",
    }),
  },
];

function seed(databaseName: string, vaultId: string): void {
  const store = new ReplicaSqliteStore(
    new NodeSqliteDriver(databaseName),
    vaultId
  );
  const apps = [
    ["people", PEOPLE],
    ["agenda", AGENDA],
  ] as const;
  store.bootstrap({
    protocolVersion: 1,
    vaultId,
    schemaEpoch: "1",
    cursor: { epoch: `epoch-${vaultId}`, seq: ROWS },
    shapes: apps.map(([appId, entities]) => ({
      shapeId: `${appId}-default`,
      appId,
      entities: entities.map((entity) => ({
        entity: entity.entity,
        primaryKey: entity.primaryKey,
        columns: [...entity.columns],
      })),
    })),
    rows: apps.flatMap(([appId, entities]) =>
      entities.flatMap((entity) =>
        Array.from({ length: ROWS }, (_ignored, index) => {
          const id = `${vaultId}-${entity.entity}-${String(index).padStart(5, "0")}`;
          return {
            shapeId: `${appId}-default`,
            entity: entity.entity,
            rowId: id,
            values: entity.row(id, index),
          };
        })
      )
    ),
  });
  store.close();
}

function household(): {
  driver: CountingDriver;
  reader: MultiVaultReplicaReader;
} {
  const root = tempDirSync("centraid-mobile-screen-reads-");
  const scopes = SCOPES.map((vaultId) => ({
    vaultId,
    label: vaultId,
    canWrite: vaultId === "personal",
    databaseName: path.join(root, `${vaultId}.db`),
  }));
  for (const scope of scopes) seed(scope.databaseName, scope.vaultId);
  const driver = new CountingDriver(path.join(root, "mounted.db"));
  return { driver, reader: new MultiVaultReplicaReader(driver, scopes) };
}

describe("People and Agenda at 5,000 rows a vault", () => {
  test("every screen read returns its declared window, not the default 1,000", async () => {
    const { driver, reader } = household();
    try {
      const results: Array<{ entity: string; rows: number; ms: number }> = [];
      const reads = [
        ...PEOPLE.map((seeded) => ({ appId: "people", seeded })),
        ...AGENDA.map((seeded) => ({ appId: "agenda", seeded })),
      ];
      // Sequential on purpose: the reader caches per app+purpose+entity, so a
      // raced pass would count a different number of statements each run.
      await forEachSequentially(reads, async ({ appId, seeded }) => {
        const before = driver.statements.length;
        const started = performance.now();
        const page = await reader.read(appId, {
          entity: seeded.entity,
          limit: MOBILE_ENTITY_READ_WINDOW,
        });
        const ms = performance.now() - started;
        results.push({ entity: seeded.entity, rows: page.rows.length, ms });
        // Constant in library size: the mounted reader's own budget is
        // `2 scopes + k`, and 10,000 rows do not add a statement to it.
        expect(driver.statements.length - before).toBeLessThanOrEqual(12);
        // The window is honoured, and 10,000 rows across two vaults fill it.
        expect(page.rows).toHaveLength(MOBILE_ENTITY_READ_WINDOW);
        // A page that filled says so rather than reading as the whole set.
        expect(page.truncated).toBe(true);
      });
      // A catastrophe bound only: a shared CI box is not a phone, and the
      // load-bearing claims above are the row count and the statement count.
      for (const result of results) expect(result.ms).toBeLessThan(20_000);
    } finally {
      reader.close();
    }
  }, 300_000);
});
