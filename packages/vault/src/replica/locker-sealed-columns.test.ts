/**
 * NO SEALED COLUMN NAME REACHES A LOCKER REPLICA SHAPE (#922 E7).
 *
 * The phone now reads Locker's list, search and trash from its own replica
 * rather than asking the gateway for each window. That is only safe because
 * the sealed half of a locker row never enters the replica lane at all —
 * `replicaUnavailableColumnsOf` is the structural deny-list, and this is the
 * assertion the seat's promise rests on.
 *
 * It is asserted over the REGISTRY, so a sixth sealed column added to
 * `locker.item` tomorrow is covered without anyone remembering to add a case,
 * and over a REAL ROW carrying real secret material, so a deny-list that
 * stopped being applied would fail here rather than in a screenshot.
 */
import { describe, expect, test } from "vitest";

import { openVaultDb } from "../db.js";
import { SEALED_COLUMNS, sealedColumnsOf } from "../schema/sealed.js";
import { readReplicaRow, readReplicaRows } from "./snapshot.js";
import { replicaUnavailableColumnsOf } from "./unavailable-columns.js";

/** Every entity the sealed registry declares columns for, Locker's included. */
const SEALED_ENTITIES = Object.keys(SEALED_COLUMNS);

describe("Locker's sealed columns and the replica lane", () => {
  test("every sealed column of every sealed entity is structurally unavailable", () => {
    for (const entity of SEALED_ENTITIES) {
      const sealed = sealedColumnsOf(entity);
      expect(sealed.length).toBeGreaterThan(0);
      const unavailable = replicaUnavailableColumnsOf(entity);
      for (const column of sealed) expect(unavailable).toContain(column);
    }
  });

  test("a locker item's row carries its browsable half and none of its secret one", () => {
    const db = openVaultDb();
    try {
      db.vault
        .prepare(
          `INSERT INTO locker_item
             (item_id, type, title, username, url, password, otp_seed,
              card_number, cvv, notes, created_at, updated_at)
           VALUES ('item-1', 'login', 'Bank', 'ada', 'https://bank.example',
                   'hunter2', 'JBSWY3DPEHPK3PXP', '4111111111111111', '123',
                   'the note', 't', 't')`
        )
        .run();

      const page = readReplicaRows(db.vault, "locker.item");
      const row = page.rows.find((candidate) => candidate.rowId === "item-1");
      expect(row).toBeDefined();

      const columns = Object.keys(row?.values ?? {});
      // The browsable half is what makes Locker usable as a projection.
      expect(columns).toContain("title");
      expect(columns).toContain("username");
      // The secret half is absent by NAME, not blanked: a column that appeared
      // as an empty string would still say the row has a password.
      for (const sealed of sealedColumnsOf("locker.item")) {
        expect(columns).not.toContain(sealed);
        expect(row?.deferredColumns ?? []).not.toContain(sealed);
      }
      // And nothing in the row's values IS the plaintext, under any key.
      expect(JSON.stringify(row?.values)).not.toContain("hunter2");
      expect(JSON.stringify(row?.values)).not.toContain("4111111111111111");

      // The single-row read a change frame takes agrees with the page.
      const single = readReplicaRow(db.vault, "locker.item", "item-1");
      for (const sealed of sealedColumnsOf("locker.item"))
        expect(Object.keys(single?.values ?? {})).not.toContain(sealed);
    } finally {
      db.close();
    }
  });
});
