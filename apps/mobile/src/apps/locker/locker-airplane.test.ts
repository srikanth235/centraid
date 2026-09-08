/**
 * LOCKER IN AIRPLANE MODE (#922 E7, #928).
 *
 * The promise this lane makes: the browsable half of a locker is the app
 * GRANT's to read, not the session's — listing an item is not unlocking it —
 * so the window, the shelves and the search come off this device's own replica
 * and need no gateway at all. What still needs one is everything that touches
 * a secret: the passphrase, the permit and the reveal.
 *
 * Airplane mode is produced, not posed. `lib/gateway` — the module every RPC
 * on this seat goes through — is replaced by one that THROWS from every door,
 * so a read that reached for the network would fail loudly rather than quietly
 * succeeding against a test double. The read plane is a real replica database
 * seeded with the locker fixture, opened through the same mounted reader the
 * provider builds on a device.
 */
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import {
  ARCHIVED_TITLE,
  LIVE_TITLES,
  TRASHED_TITLE,
  VAULT_ID,
  seedScope,
} from "../../lib/replica/locker-vault.test-fixtures";
import { MultiVaultReplicaReader } from "../../lib/replica/multi-vault-reader";
import { NodeSqliteDriver } from "../../lib/replica/node-sqlite-driver";
import {
  attachLockerReadPlane,
  lockerItems,
  lockerSearch,
  lockerTrash,
} from "./locker-reads";

// No network exists. Any door this seat could reach for throws.
vi.mock(import("../../lib/gateway"), () => {
  const refuse = (): never => {
    throw new Error("airplane mode: no gateway is reachable");
  };
  // `then` stays undefined: an awaited module namespace carrying a callable
  // `then` is treated as a thenable, and the refusal would fire at import.
  return new Proxy({} as never, {
    get: (_target, key) => (key === "then" ? undefined : refuse),
    has: () => true,
  });
});

let reader: MultiVaultReplicaReader | undefined;

const titles = (rows: ReadonlyArray<{ title: string }> = []): string[] =>
  rows.map((row) => row.title);

describe("Locker on a plane", () => {
  beforeEach(() => {
    const root = tempDirSync("centraid-locker-airplane-");
    const databaseName = path.join(root, "personal.db");
    seedScope(databaseName);
    reader = new MultiVaultReplicaReader(
      new NodeSqliteDriver(path.join(root, "mounted.db")),
      [{ vaultId: VAULT_ID, label: "Personal", canWrite: true, databaseName }]
    );
    attachLockerReadPlane({
      read: reader.read.bind(reader),
      search: reader.search.bind(reader),
    });
  });

  afterEach(() => {
    attachLockerReadPlane(undefined);
    reader?.close();
    reader = undefined;
  });

  test("the window lands complete, with no gateway at all", async () => {
    const payload = await lockerItems();

    expect(payload.vaultDenied).toBeUndefined();
    // COMPLETE, not partial: every live row, in the window's own order, and
    // the archived and trashed rows are out of it by construction.
    expect(titles(payload.items)).toStrictEqual([...LIVE_TITLES]);
    const bank = payload.items?.find((row) => row.title === "Bank");
    // Decorated from rows the replica carries: the star, the tag, the alias,
    // the address and the breach flag are all browsable columns.
    expect(bank?.favorite).toBe(true);
    expect(bank?.tags).toStrictEqual(["money"]);
    expect(bank?.alias).toBe("bank");
    expect(bank?.compromised).toBe(true);
    expect(bank?.subtitle).toBe("ada");
  });

  test("the shelves are their own reads, and they land too", async () => {
    const archived = await lockerItems(300, true);
    expect(titles(archived.items)).toStrictEqual([ARCHIVED_TITLE]);
    expect(archived.archived).toBe(true);

    const trash = await lockerTrash();
    expect(titles(trash.items)).toStrictEqual([TRASHED_TITLE]);
    expect(trash.items?.[0]?.purge_at).toBe("2026-04-01T00:00:00.000Z");
  });

  test("a search answers its rows though Watchtower is unreachable", async () => {
    const byTitle = await lockerSearch("bank");
    expect(titles(byTitle.items)).toStrictEqual(["Bank"]);
    // Matched over a field the payload never returns, across the whole live
    // set — the archived shelf's rows are searchable, the trashed ones are not.
    const byUsername = await lockerSearch("isp.test");
    expect(titles(byUsername.items)).toStrictEqual([ARCHIVED_TITLE]);
    expect(titles((await lockerSearch("forum")).items)).toStrictEqual([]);
    const live = await lockerSearch("ada@example.test");
    expect(titles(live.items)).toStrictEqual(["Webmail"]);
  });

  test("an undecorated row says the check did not run rather than passing it", async () => {
    const payload = await lockerItems();
    // `weak`/`reused` are derived inside the vault's sealed boundary. Absent,
    // not false — a false would be this seat reporting an all-clear it never
    // asked for — and the payload's own summary is absent with them.
    for (const row of payload.items ?? []) {
      expect("weak" in row).toBe(false);
      expect("reused" in row).toBe(false);
    }
    expect(payload.watchtower).toBeUndefined();
    // The one strength verdict that IS a stored column still lands.
    expect(
      payload.items?.find((row) => row.title === "Bank")?.compromised
    ).toBe(true);
  });

  test("no sealed column rides any row this seat reads", async () => {
    // By NAME, not by substring: `password_set_at` is a plain column and the
    // Review surface reads it, so the assertion is over the keys themselves.
    const sealed = ["password", "otp_seed", "card_number", "cvv", "content"];
    const rows = [
      ...((await lockerItems()).items ?? []),
      ...((await lockerSearch("ada")).items ?? []),
      ...((await lockerTrash()).items ?? []),
    ];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows)
      for (const column of sealed)
        expect(Object.keys(row)).not.toContain(column);
  });

  test("a seat with no replica mounted says so instead of drawing an empty locker", async () => {
    attachLockerReadPlane(undefined);
    await expect(lockerItems()).rejects.toThrow(/mounting/u);
  });

  test("the secret half still refuses: a reveal needs the gateway", async () => {
    const { lockerItem } = await import("./locker-gateway");
    expect(() => lockerItem("s1", "item-2", "t1")).toThrow(/airplane mode/u);
  });
});
