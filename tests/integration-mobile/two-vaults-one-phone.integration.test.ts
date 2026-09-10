/*
 * TWO VAULTS ON ONE PHONE, AND THE SWITCH BETWEEN THEM (#1014, R25).
 *
 * The critical defect this umbrella opened on, at the tier that has the real
 * doors. On the device: a phone paired to `Personal` and `Family`, cold-
 * launched with Family active, switched to Personal — and the Personal seat
 * file came back holding FAMILY's epoch, Family's rows, and no `seat_state`,
 * `seat_outbox` or `seat_outbox_settled` at all. The replicated rows were
 * recoverable; the queued `update-asset` intent in the destroyed outbox was
 * not. Then the phone re-downloaded that same wrong artifact every ~6 s,
 * through an unpair and a relaunch, for 560 lines of gateway log.
 *
 * Three claims here, and each is a different half of the mechanism:
 *
 *   1. TWO SEATS, TWO FILES, NOTHING SHARED. Ten switches with an intent
 *      queued on the inactive vault, and both files keep their own epoch,
 *      their own `seat_state` and their own outbox — and the queued write
 *      lands in ITS vault, not in whichever one was active when it drained.
 *   2. A MIS-ADDRESSED ARTIFACT IS REFUSED BY NAME (C16). The snapshot door
 *      answering for the wrong vault is refused before the destination is
 *      touched, so the seat that was there is still there.
 *   3. A POISONED FILE REPAIRS ITSELF, ONCE (C17 + C14). A file holding
 *      another vault's rows with no `seat_state` — R25's forensic shape — is
 *      re-bootstrapped, correctly, without touching any other seat file, and
 *      the repair does not become a loop.
 */

import { copyFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { nativeSeatDatabaseName } from "../../apps/mobile/src/lib/replica/native-seat-path.js";
import { NodeSeatDriver } from "../../packages/client/src/replica/seat/node-seat-driver.js";
import {
  ROUTES,
  SEAT_SNAPSHOT_VAULT_HEADER,
} from "../../packages/core/src/protocol/index.js";
import { bootMobileGateway } from "./lib/gateway.js";
import type { MobileGateway } from "./lib/gateway.js";
import { openNodeSeat } from "./lib/node-seat.js";
import { readEntity } from "./lib/reads.js";
import { drain, openSeat } from "./lib/seat.js";
import type { MobileSeat } from "./lib/seat.js";

/** The phone's own hash, in a node process. */
const digest = (value: string): Promise<string> =>
  import("node:crypto").then((crypto) =>
    crypto.createHash("sha256").update(value, "utf8").digest("hex")
  );

const GATEWAY_ID = "mobile-integration";

interface SeatFile {
  readonly vaultId: string;
  readonly seat: MobileSeat;
  readonly file: string;
}

/**
 * What this seat FILE says about itself, read straight out of it.
 *
 * Through the file rather than through the session on purpose: R25's file
 * passed `pragma integrity_check` and answered reads — it was simply another
 * vault's, with the seat's own tables missing. Only the file can be asked
 * that, and `tables` is here because "absent" was the finding.
 */
function inspect(file: string): {
  epoch: string;
  outbox: number;
  tables: string[];
} {
  const driver = new NodeSeatDriver(file);
  try {
    const tables = driver
      .all<{ name: string }>(
        `SELECT name FROM sqlite_schema WHERE type = 'table'
           AND name IN ('seat_state', 'seat_outbox') ORDER BY name`
      )
      .map((row) => row.name);
    const [state] = tables.includes("seat_state")
      ? driver.all<{ epoch: string }>(
          `SELECT epoch FROM seat_state WHERE singleton = 1`
        )
      : [];
    const [queued] = tables.includes("seat_outbox")
      ? driver.all<{ n: number }>(`SELECT COUNT(*) AS n FROM seat_outbox`)
      : [];
    return {
      epoch: state?.epoch ?? "",
      outbox: queued?.n ?? -1,
      tables,
    };
  } finally {
    driver.close();
  }
}

/** Both of the seat's own tables, which R25's poisoned file had neither of. */
const SEAT_TABLES = ["seat_outbox", "seat_state"];

describe("two vaults on one phone", () => {
  let gateway: MobileGateway;
  let storage: string;
  let personal: SeatFile;
  let family: SeatFile;

  beforeAll(async () => {
    gateway = await bootMobileGateway("two-vaults");
    // ONE STORAGE DIRECTORY, THE SHIPPED NAMING. `centraid-seat-<hash(gateway,
    // vault)>.sqlite3` is what tells the two files apart on a real phone, so
    // the suite uses the builder rather than two names of its own.
    storage = path.join(gateway.dataDir, "CentraidReplica");
    const familyVaultId = await gateway.createVault("Family");
    personal = await open(gateway.vaultId, "personal");
    family = await open(familyVaultId, "family");
  }, 60_000);

  async function open(vaultId: string, label: string): Promise<SeatFile> {
    const fileName = await nativeSeatDatabaseName({
      gatewayId: GATEWAY_ID,
      vaultId,
      digest,
    });
    const seat = await openSeat(gateway, {
      label,
      vaultId,
      directory: storage,
      fileName,
    });
    return { vaultId, seat, file: path.join(storage, fileName) };
  }

  afterAll(async () => {
    await personal?.seat.close();
    await family?.seat.close();
    await gateway?.close();
  });

  test("ten switches lose neither vault's copy nor either outbox", async () => {
    await gateway.callAction(
      "docs",
      "upload",
      { data_uri: "data:text/plain;base64,cGVyc29uYWw=", title: "Personal A" },
      personal.vaultId
    );
    await gateway.callAction(
      "docs",
      "upload",
      { data_uri: "data:text/plain;base64,ZmFtaWx5", title: "Family A" },
      family.vaultId
    );
    await personal.seat.session.pullNow();
    await family.seat.session.pullNow();

    const epochs = {
      personal: inspect(personal.file).epoch,
      family: inspect(family.file).epoch,
    };
    // Two vaults founded on one gateway are two logs: same file naming, two
    // epochs. If these were ever equal the rest of this suite proves nothing.
    expect(epochs.personal).not.toBe("");
    expect(epochs.personal).not.toBe(epochs.family);

    // A write queued on the vault that is NOT the one being pulled — the
    // arrangement in which R25 destroyed the outbox.
    family.seat.cut();
    const queued = (await family.seat.session.write("docs", {
      action: "upload",
      input: {
        data_uri: "data:text/plain;base64,cXVldWVk",
        title: "Queued in Family",
      },
    })) as { intentId?: string };
    family.seat.restore();
    expect(queued.intentId).toBeDefined();
    expect(inspect(family.file).outbox).toBeGreaterThan(0);

    // THE SWITCH, TEN TIMES. On the phone this is the switcher; here it is
    // the same thing the switcher causes — one mount pulling while the other
    // sits — because what R25 broke was the FILES, not the UI.
    for (let round = 0; round < 10; round += 1) {
      const active = round % 2 === 0 ? personal : family;
      // oxlint-disable-next-line no-await-in-loop
      await active.seat.session.pullNow();
    }

    // Both files still their own, with their own tables.
    expect(inspect(personal.file)).toMatchObject({
      epoch: epochs.personal,
      tables: SEAT_TABLES,
    });
    expect(inspect(family.file)).toMatchObject({
      epoch: epochs.family,
      tables: SEAT_TABLES,
    });
    // The queued intent survived every switch, in the file it was queued in.
    expect(inspect(family.file).outbox).toBeGreaterThan(0);
    expect(inspect(personal.file).outbox).toBe(0);

    // …and it lands in ITS vault, not in whichever one was last active.
    await drain(family.seat);
    await family.seat.session.pullNow();
    await personal.seat.session.pullNow();
    const familyTitles = (await readEntity(family.seat, "core.document")).rows
      .map((row) => row["title"])
      .sort();
    const personalTitles = (
      await readEntity(personal.seat, "core.document")
    ).rows
      .map((row) => row["title"])
      .sort();
    expect(familyTitles).toContain("Queued in Family");
    expect(personalTitles).not.toContain("Queued in Family");
    expect(personalTitles).toContain("Personal A");
    expect(familyTitles).not.toContain("Personal A");
  }, 120_000);

  // #1014, C16. R25's third act: the gateway served a FAMILY snapshot into the
  // PERSONAL seat file, and no later check could notice, because the seat
  // wrote its own vault id onto whatever arrived.
  test("the snapshot door names its vault, and a seat refuses the wrong one", async () => {
    const head = await fetch(`${gateway.url}${ROUTES.vaultSeatSnapshot}`, {
      method: "HEAD",
      headers: {
        Authorization: `Bearer ${gateway.token}`,
        "x-centraid-vault": family.vaultId,
      },
    });
    expect(head.headers.get(SEAT_SNAPSHOT_VAULT_HEADER)).toBe(family.vaultId);

    // THE MIS-ADDRESSED BOOTSTRAP, ARRANGED DELIBERATELY. The seat believes it
    // is Family's; every door it asks is addressed to PERSONAL. Before #1014
    // this installed Personal's artifact under Family's name and every later
    // check agreed with it.
    const file = path.join(storage, "misaddressed-seat.sqlite3");
    rmSync(file, { force: true });
    copyFileSync(family.file, file);
    const misaddressed = await openNodeSeat({
      directory: storage,
      fileName: "misaddressed-seat.sqlite3",
      vaultId: family.vaultId,
      baseUrl: gateway.url,
      headers: {
        Authorization: `Bearer ${gateway.token}`,
        "x-centraid-vault": personal.vaultId,
      },
    });
    try {
      // Read AFTER the open: opening a seat file creates `seat_outbox` if it
      // is not there, which is the worker doing its job and not the bootstrap.
      const before = inspect(file);
      expect(before.tables).toStrictEqual(SEAT_TABLES);
      const refused = await misaddressed.sync().then(
        () => undefined,
        (error: unknown) => error
      );
      expect((refused as Error).message).toContain("vault");
      // And the file that was there is still Family's, seat tables and all —
      // which is the whole property: a refusal never costs the member a copy.
      expect(inspect(file)).toStrictEqual(before);
    } finally {
      await misaddressed.close();
    }
  }, 60_000);

  // #1014, C17 + C14. R25's forensic shape exactly: a well-formed file holding
  // another vault's epoch with `seat_state` absent, which `worker-core.ts`
  // reads as "this seat has no copy".
  test("a poisoned seat file repairs itself once, and touches no other file", async () => {
    const poisoned = path.join(storage, "poisoned-seat.sqlite3");
    rmSync(poisoned, { force: true });
    copyFileSync(family.file, poisoned);
    const scrub = new NodeSeatDriver(poisoned);
    scrub.exec("DROP TABLE IF EXISTS seat_state");
    scrub.close();
    rmSync(`${poisoned}-wal`, { force: true });
    rmSync(`${poisoned}-shm`, { force: true });

    const familyBefore = inspect(family.file);
    const repaired = await openSeat(gateway, {
      label: "poisoned",
      vaultId: personal.vaultId,
      directory: storage,
      fileName: "poisoned-seat.sqlite3",
    });
    try {
      // It bootstrapped: the file now holds PERSONAL's epoch and its own
      // seat tables, rather than Family's rows under Personal's name.
      expect(inspect(poisoned).epoch).toBe(inspect(personal.file).epoch);
      expect(inspect(poisoned).outbox).toBe(0);

      // BOUNDED. R25's phone asked for a snapshot every ~6 s forever; this one
      // asks once more and stops, because the copy is now correct.
      const asked = repaired.attempts.filter((at) =>
        at.includes("seat/snapshot")
      ).length;
      await repaired.session.pullNow();
      expect(
        repaired.attempts.filter((at) => at.includes("seat/snapshot"))
      ).toHaveLength(asked);

      // And no other seat file moved while it repaired itself.
      expect(inspect(family.file)).toStrictEqual(familyBefore);
      expect(existsSync(family.file)).toBe(true);
    } finally {
      await repaired.session.close();
    }
  }, 120_000);
});
