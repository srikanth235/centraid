/**
 * The seat file a `"manual"` mount left behind (#1014, P14).
 *
 * The rename is the only thing that rescues an outbox queued before the
 * gateway named itself: the rows in that file are on the gateway, the member's
 * unsent writes are not.
 */
import { describe, expect, it, vi } from "vitest";

const files = new Map<string, number>();

class FakeFile {
  constructor(readonly uri: string) {}
  get exists(): boolean {
    return files.has(this.uri);
  }
  moveSync(destination: FakeFile): void {
    const size = files.get(this.uri);
    if (size === undefined) throw new Error(`no such file: ${this.uri}`);
    files.delete(this.uri);
    files.set(destination.uri, size);
  }
}

vi.mock(import("expo-file-system") as Promise<unknown>, () => ({
  File: FakeFile,
}));

vi.mock(
  import("../../../modules/centraid-storage") as Promise<unknown>,
  () => ({
    pathToFileUri: (path: string) => `file://${path}`,
    replicaStorageDirectory: () => "/durable/CentraidReplica",
  })
);

const { migrateManualSeatFiles } = await import("./manual-seat-migration");

/** The suite's digest — `native-seat-path` builds the name from it. */
const digest = (value: string): Promise<string> =>
  Promise.resolve(value.replaceAll(String.fromCodePoint(0), "+"));

const at = (name: string): string =>
  `file:///durable/CentraidReplica/centraid-seat-${name}.sqlite3`;

describe("migrating a manual-named seat file", () => {
  it("renames the file and every sidecar onto the resolved name", async () => {
    files.clear();
    files.set(at("manual+vault-a"), 5_000_000);
    files.set(`${at("manual+vault-a")}-wal`, 4_096);

    await expect(
      migrateManualSeatFiles({ gatewayId: "gw-1", vaultId: "vault-a", digest })
    ).resolves.toBe("renamed");

    expect(files.has(at("manual+vault-a"))).toBe(false);
    expect(files.get(at("gw-1+vault-a"))).toBe(5_000_000);
    expect(files.get(`${at("gw-1+vault-a")}-wal`)).toBe(4_096);
  });

  it("leaves a live seat alone rather than overwriting its outbox", async () => {
    files.clear();
    files.set(at("manual+vault-a"), 1_000);
    files.set(at("gw-1+vault-a"), 5_000_000);

    await expect(
      migrateManualSeatFiles({ gatewayId: "gw-1", vaultId: "vault-a", digest })
    ).resolves.toBe("blocked");

    // Both still there: the orphan stays visible to storage accounting (P6)
    // instead of being deleted with a member's queued writes inside it.
    expect(files.get(at("manual+vault-a"))).toBe(1_000);
    expect(files.get(at("gw-1+vault-a"))).toBe(5_000_000);
  });

  it("does nothing on the ordinary phone, which never ran the fallback", async () => {
    files.clear();
    files.set(at("gw-1+vault-a"), 5_000_000);

    await expect(
      migrateManualSeatFiles({ gatewayId: "gw-1", vaultId: "vault-a", digest })
    ).resolves.toBe("absent");
  });
});
