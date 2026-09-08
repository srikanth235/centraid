/**
 * PEOPLE AND AGENDA ON A PHONE AT YEAR-3 VOLUME (#922 E2, #996 W5).
 *
 * Both screens read whole entities: People holds a roster read plus its tags,
 * concepts and dates; Agenda holds eleven, one per layer of a day. Before this
 * lane every one of those reads said `acceptTruncation: true` — "the default
 * window is fine" — and the default was 1,000. At the year-3 roster of 5,000
 * people that is a screen the member counts and believes.
 *
 * WHAT A READ IS NOW. A statement over the seat's own copy of the vault,
 * keyset-paged. So the claim this rig makes has become sharper rather than
 * weaker: the cost of one page is proportional to the PAGE, not to the
 * library — one statement, and the same one, whether the table holds 520 rows
 * or 10,000 — and a walk reaches every row rather than stopping at a window
 * nobody chose.
 *
 * VOLUME TABLE (year-3, the one open vault):
 *   core_party           10,000
 *   people_profile       10,000
 *   core_event           10,000
 *   schedule_attendee    10,000
 *
 * Assertions are catastrophe bounds. The load-bearing claims are the ROW COUNT
 * (the walk reaches everything) and the STATEMENT COUNT (constant in library
 * size); the milliseconds are printed for the receipt, and gated only loosely
 * because a shared CI box is not a phone.
 */
import path from "node:path";

import { describe, expect, test } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { MOBILE_ENTITY_READ_WINDOW } from "../../apps/mobile/src/lib/replica/offline-budgets";
import type { SeatBindValue } from "../../packages/client/src/replica/seat/driver.js";
import { NodeSeatDriver } from "../../packages/client/src/replica/seat/node-seat-driver.js";
import { seatWorkerPage } from "../../packages/client/src/replica/seat/seat-page-reader.js";
import type { SeatQueryPort } from "../../packages/client/src/replica/seat/seat-page-reader.js";
import type { SeatWorkerQuery } from "../../packages/client/src/replica/seat/worker-protocol.js";

/**
 * TEN THOUSAND IN ONE FILE (#996 wave 3). The rig used to seed 5,000 per vault
 * across two mounted vaults, and the window is 5,000 — so the page that filled
 * it drew from a library twice its size. A seat opens ONE file, so the same
 * claim needs the same library in one place.
 */
const ROWS = 10_000;

interface Seeded {
  table: string;
  pkColumn: string;
  sortColumn: string;
  ddl: string;
  insert: string;
  bind: (id: string, index: number) => Array<string | number | null>;
}

const SEEDED: Seeded[] = [
  {
    table: "core_party",
    pkColumn: "party_id",
    sortColumn: "display_name",
    ddl: `CREATE TABLE core_party (
            party_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, kind TEXT
          ) STRICT`,
    insert:
      "INSERT INTO core_party (party_id, display_name, kind) VALUES (?,?,?)",
    bind: (id, index) => [
      id,
      `Person ${String(index).padStart(5, "0")}`,
      "person",
    ],
  },
  {
    table: "people_profile",
    pkColumn: "profile_id",
    sortColumn: "profile_id",
    ddl: `CREATE TABLE people_profile (
            profile_id TEXT PRIMARY KEY, party_id TEXT NOT NULL,
            cadence_days INTEGER, deleted_at TEXT
          ) STRICT`,
    insert: `INSERT INTO people_profile
               (profile_id, party_id, cadence_days, deleted_at)
             VALUES (?,?,?,NULL)`,
    bind: (id, index) => [id, id, 30 + (index % 90)],
  },
  {
    table: "core_event",
    pkColumn: "event_id",
    sortColumn: "dtstart",
    ddl: `CREATE TABLE core_event (
            event_id TEXT PRIMARY KEY, calendar_id TEXT NOT NULL,
            summary TEXT, dtstart TEXT NOT NULL
          ) STRICT`,
    insert: `INSERT INTO core_event (event_id, calendar_id, summary, dtstart)
             VALUES (?,?,?,?)`,
    bind: (id, index) => [
      id,
      "cal-1",
      `Event ${index}`,
      new Date(1_760_000_000_000 + index * 3_600_000).toISOString(),
    ],
  },
  {
    table: "schedule_attendee",
    pkColumn: "attendee_id",
    sortColumn: "attendee_id",
    ddl: `CREATE TABLE schedule_attendee (
            attendee_id TEXT PRIMARY KEY, event_id TEXT NOT NULL,
            party_id TEXT NOT NULL, partstat TEXT
          ) STRICT`,
    insert: `INSERT INTO schedule_attendee
               (attendee_id, event_id, party_id, partstat)
             VALUES (?,?,?,?)`,
    bind: (id, index) => [id, id, `party-${index}`, "needs-action"],
  },
];

/** Every statement the walk actually put to SQLite, so the count is measured. */
class CountingDriver extends NodeSeatDriver {
  readonly statements: string[] = [];

  override all<T extends object>(
    sql: string,
    bind: readonly SeatBindValue[] = []
  ): T[] {
    this.statements.push(sql);
    return super.all<T>(sql, bind);
  }
}

function household(): CountingDriver {
  const root = tempDirSync("centraid-mobile-screen-reads-");
  const driver = new CountingDriver(path.join(root, "seat.db"));
  for (const seeded of SEEDED) {
    driver.exec(seeded.ddl);
    driver.exec("BEGIN");
    for (let index = 0; index < ROWS; index += 1) {
      driver.run(
        seeded.insert,
        seeded.bind(`${seeded.table}-${String(index).padStart(5, "0")}`, index)
      );
    }
    driver.exec("COMMIT");
  }
  return driver;
}

describe("People and Agenda at 10,000 rows in the open vault", () => {
  test("a screen's walk reaches every row at a constant statement cost", async () => {
    const driver = household();
    const port: SeatQueryPort = {
      query: <T extends object>(request: SeatWorkerQuery): Promise<T[]> =>
        Promise.resolve(driver.all<T>(request.sql, request.bind ?? [])),
    };
    try {
      const results: Array<{ table: string; rows: number; ms: number }> = [];
      await forEachSequentially(SEEDED, async (seeded) => {
        const query = {
          name: `screen.${seeded.table}`,
          select: "*",
          from: `"${seeded.table}"`,
          order: {
            sortColumn: seeded.sortColumn,
            pkColumn: seeded.pkColumn,
            descending: false,
          },
        };
        const started = performance.now();
        let rows = 0;
        let pages = 0;
        let after: { sortKey: string; pk: string } | undefined;
        const before = driver.statements.length;
        for (;;) {
          pages += 1;
          // Sequential by definition: the next page continues from this one.
          // oxlint-disable-next-line no-await-in-loop
          const page = await seatWorkerPage(port, query, {
            limit: MOBILE_ENTITY_READ_WINDOW,
            ...(after ? { after } : {}),
          });
          rows += page.rows.length;
          if (!page.next) break;
          after = page.next;
        }
        const ms = performance.now() - started;
        results.push({ table: seeded.table, rows, ms });
        // THE WALK REACHES EVERYTHING. The old default stopped at 1,000 and
        // said nothing; a keyset walk ends when the table does.
        expect(rows).toBe(ROWS);
        // ONE STATEMENT PER PAGE, and the page size is the window — so the
        // cost is proportional to the answer, not to the library.
        expect(driver.statements.length - before).toBe(pages);
        expect(pages).toBe(Math.ceil(ROWS / MOBILE_ENTITY_READ_WINDOW) + 1);
      });
      // A catastrophe bound only: a shared CI box is not a phone, and the
      // load-bearing claims above are the row count and the statement count.
      for (const result of results) expect(result.ms).toBeLessThan(20_000);
    } finally {
      driver.close();
    }
  }, 300_000);
});
