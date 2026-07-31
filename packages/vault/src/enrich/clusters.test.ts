// Near-duplicate clustering (issue #352 phase 3/4) — see clusters.ts header
// for the app-plane gap this closes (media_asset_phash was unreachable from
// consent.app_view: no SQL functions, no registered logical entity).

import { beforeEach, describe, expect, test } from "vitest";

import { seededRandom } from "@centraid/test-kit/random";

import { bootstrapVault } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { registerMediaCommands } from "../commands/media.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import type { Gateway } from "../gateway/gateway.js";
import { createGateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import {
  DUPLICATE_HAMMING_THRESHOLD,
  recomputeDuplicateClusters,
} from "./clusters.js";
import { hexHamming } from "./similarity.js";

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

const compareStringValues = (left: unknown, right: unknown): number => {
  const leftString = String(left);
  const rightString = String(right);
  return leftString < rightString ? -1 : leftString > rightString ? 1 : 0;
};

describe("clusters", () => {
  beforeEach(() => {
    db = openVaultDb();
    boot = bootstrapVault(db, { ownerName: "Priya" });
    gw = createGateway(db);
    registerMediaCommands(gw);
    owner = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
  });

  /** Distinct pixel data URIs so each mints its OWN asset (sha256 differs). */
  const PIXELS = [
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA3bvkkAAAACklEQVR4nGNgAAIAAAUAAen63NgAAAAASUVORK5CYII=",
  ];

  function addAssetVariant(index: number, phash: string): string {
    const outcome = gw.invoke(owner, {
      command: "media.add_asset",
      input: { data_uri: PIXELS[index], phash },
      purpose: "dpv:ServiceProvision",
    });
    expect(outcome.status).toBe("executed");
    return (outcome as { status: "executed"; output: { asset_id: string } })
      .output.asset_id;
  }

  test("assets within the hamming threshold cluster together with a deterministic id", () => {
    const a = addAssetVariant(0, "ff00ff00");
    const b = addAssetVariant(1, "ff00ff01"); // hamming distance 1 from a
    const c = addAssetVariant(2, "00000000"); // far from both
    const result = recomputeDuplicateClusters(db.vault);
    expect(result.clusters).toBe(1);
    expect(result.clustered).toBe(2);
    const rows = db.vault
      .prepare(
        "SELECT asset_id, cluster_id FROM media_asset_phash WHERE asset_id IN (?, ?, ?)"
      )
      .all(a, b, c) as { asset_id: string; cluster_id: string | null }[];
    const byId = new Map(rows.map((r) => [r.asset_id, r.cluster_id]));
    expect(byId.get(a)).not.toBeNull();
    expect(byId.get(a)).toBe(byId.get(b));
    expect(byId.get(c)).toBeNull();
    // Deterministic: the cluster id is the lowest asset_id in the group.
    expect(byId.get(a)).toBe([a, b].sort()[0]);
  });

  test("a trashed asset drops out of its cluster on recompute", () => {
    const a = addAssetVariant(0, "aaaaaaaa");
    const b = addAssetVariant(1, "aaaaaaab");
    recomputeDuplicateClusters(db.vault);
    gw.invoke(owner, {
      command: "media.delete_asset",
      input: { asset_id: a },
      purpose: "dpv:ServiceProvision",
    });
    const result = recomputeDuplicateClusters(db.vault);
    expect(result.clusters).toBe(0);
    const row = db.vault
      .prepare("SELECT cluster_id FROM media_asset_phash WHERE asset_id = ?")
      .get(b) as { cluster_id: string | null };
    expect(row.cluster_id).toBeNull();
  });

  test("the standing sweep (gateway.sweep) recomputes clusters automatically", () => {
    const a = addAssetVariant(0, "bbbbbbbb");
    const b = addAssetVariant(1, "bbbbbbbc");
    gw.sweep(owner);
    const rows = db.vault
      .prepare(
        "SELECT cluster_id FROM media_asset_phash WHERE asset_id IN (?, ?)"
      )
      .all(a, b) as { cluster_id: string | null }[];
    expect(rows.every((r) => r.cluster_id !== null)).toBe(true);
  });

  test("clusters are read through the registered media.asset_phash entity, no SQL function needed", () => {
    const a = addAssetVariant(0, "cccccccc");
    const b = addAssetVariant(1, "cccccccd");
    recomputeDuplicateClusters(db.vault);
    const rows = gw.read(owner, {
      entity: "media.asset_phash",
      where: [{ column: "cluster_id", op: "not-null" }],
      purpose: "dpv:ServiceProvision",
    }).rows;
    expect(rows.map((r) => r.asset_id).sort(compareStringValues)).toStrictEqual(
      [a, b].sort(compareStringValues)
    );
  });

  // ── issue #659 G1/G2: the banded index and the write budget ───────────

  /** Seed phash rows directly — the bulk shape the sweep actually meets. */
  function seedPhashes(phashes: readonly string[]): string[] {
    const content = db.vault.prepare(
      `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, created_at)
       VALUES (?, 'image/png', ?, ?, 1, '2026-01-01T00:00:00.000Z')`
    );
    const asset = db.vault.prepare(
      `INSERT INTO media_media_asset (asset_id, content_id, kind)
       VALUES (?, ?, 'photo')`
    );
    const phash = db.vault.prepare(
      `INSERT INTO media_asset_phash (asset_id, phash, computed_at)
       VALUES (?, ?, '2026-01-01T00:00:00.000Z')`
    );
    const ids: string[] = [];
    db.vault.exec("BEGIN");
    for (const [index, value] of phashes.entries()) {
      const id = `seeded-asset-${index.toString().padStart(6, "0")}`;
      const contentId = `seeded-content-${index.toString().padStart(6, "0")}`;
      content.run(contentId, `blob:${contentId}`, contentId);
      asset.run(id, contentId);
      phash.run(id, value);
      ids.push(id);
    }
    db.vault.exec("COMMIT");
    return ids;
  }

  /** The pre-#659 pairwise clustering, kept as the equivalence oracle. */
  function bruteForceClusterIds(
    rows: readonly { assetId: string; phash: string }[],
    threshold: number
  ): Map<string, string | null> {
    const parent = new Map(rows.map((r) => [r.assetId, r.assetId]));
    const find = (id: string): string => {
      let root = id;
      while (parent.get(root) !== root) root = parent.get(root) as string;
      return root;
    };
    for (let i = 0; i < rows.length; i += 1)
      for (let j = i + 1; j < rows.length; j += 1) {
        const d = hexHamming(rows[i]!.phash, rows[j]!.phash);
        if (d === null || d > threshold) continue;
        const ra = find(rows[i]!.assetId);
        const rb = find(rows[j]!.assetId);
        if (ra !== rb) parent.set(ra, rb);
      }
    const groups = new Map<string, string[]>();
    for (const row of rows) {
      const root = find(row.assetId);
      const members = groups.get(root);
      if (members) members.push(row.assetId);
      else groups.set(root, [row.assetId]);
    }
    const out = new Map<string, string | null>();
    for (const members of groups.values()) {
      const clusterId = members.length < 2 ? null : [...members].sort()[0]!;
      for (const m of members) out.set(m, clusterId);
    }
    return out;
  }

  function storedClusterIds(): Map<string, string | null> {
    const rows = db.vault
      .prepare("SELECT asset_id, cluster_id FROM media_asset_phash")
      .all() as { asset_id: string; cluster_id: string | null }[];
    return new Map(rows.map((r) => [r.asset_id, r.cluster_id]));
  }

  function totalChanges(): number {
    return (
      db.vault.prepare("SELECT total_changes() AS n").get() as { n: number }
    ).n;
  }

  test("the banded index reproduces the pairwise clustering exactly", () => {
    const random = seededRandom(659_001);
    // Mixed corpus: tight families around random seeds (the near-duplicate
    // case the threshold exists for) plus loners, so both branches of the
    // pigeonhole filter are exercised.
    const hex = (): string =>
      Array.from(
        { length: 16 },
        () => "0123456789abcdef"[random.int(0, 15)]!
      ).join("");
    const phashes: string[] = [];
    for (let family = 0; family < 40; family += 1) {
      const seed = hex();
      phashes.push(seed);
      for (let member = 0; member < 4; member += 1) {
        const chars = [...seed];
        const at = random.int(0, chars.length - 1);
        chars[at] = "0123456789abcdef"[random.int(0, 15)]!;
        phashes.push(chars.join(""));
      }
    }
    for (let loner = 0; loner < 100; loner += 1) phashes.push(hex());
    const ids = seedPhashes(phashes);

    recomputeDuplicateClusters(db.vault);

    const expected = bruteForceClusterIds(
      ids.map((assetId, index) => ({ assetId, phash: phashes[index]! })),
      DUPLICATE_HAMMING_THRESHOLD
    );
    const actual = storedClusterIds();
    for (const [assetId, clusterId] of expected)
      expect(actual.get(assetId)).toBe(clusterId);
    // The corpus is not trivially all-singleton or all-one-cluster.
    const clustered = [...expected.values()].filter((v) => v !== null).length;
    expect(clustered).toBeGreaterThan(40);
    expect(clustered).toBeLessThan(expected.size);
  });

  test("a sweep over unchanged phashes writes nothing", () => {
    seedPhashes(["ff00ff00", "ff00ff01", "0f0f0f0f", "00000000"]);
    const first = recomputeDuplicateClusters(db.vault);
    expect(first.updated).toBeGreaterThan(0);
    expect(first.reused).toBe(false);

    const before = totalChanges();
    const second = recomputeDuplicateClusters(db.vault);
    expect(totalChanges()).toBe(before);
    expect(second.updated).toBe(0);
    expect(second.reused).toBe(true);
    expect(second.clusters).toBe(first.clusters);
    expect(second.clustered).toBe(first.clustered);
  });

  test("a changed phash rewrites only the rows whose cluster actually moved", () => {
    const ids = seedPhashes([
      "ff00ff00",
      "ff00ff01",
      "0f0f0f0f",
      "00000000",
      "12345678",
    ]);
    recomputeDuplicateClusters(db.vault);
    // A newcomer next to the existing pair: it joins their cluster, and no
    // other row's cluster_id may be rewritten. Its id sorts AFTER the
    // incumbents' so the group's lowest-id cluster key is unchanged — the
    // stability property the projection promises apps.
    db.vault
      .prepare(
        `INSERT INTO core_content_item
           (content_id, media_type, content_uri, sha256, byte_size, created_at)
         VALUES ('zz-late-content', 'image/png', 'blob:zz-late', 'zz-late', 1, '2026-01-02T00:00:00.000Z')`
      )
      .run();
    db.vault
      .prepare(
        `INSERT INTO media_media_asset (asset_id, content_id, kind)
         VALUES ('zz-late-asset', 'zz-late-content', 'photo')`
      )
      .run();
    db.vault
      .prepare(
        `INSERT INTO media_asset_phash (asset_id, phash, computed_at)
         VALUES ('zz-late-asset', 'ff00ff03', '2026-01-02T00:00:00.000Z')`
      )
      .run();

    const before = totalChanges();
    const result = recomputeDuplicateClusters(db.vault);
    // Exactly one row moved (the newcomer); the incumbent pair keeps the
    // cluster id it already displayed.
    expect(result.updated).toBe(1);
    // The engine's counter ticks twice per written row (measured), so the
    // load-bearing assertion is that writes scale with rows that MOVED, not
    // with the size of the table — a wholesale reset would tick 12 here.
    const delta = totalChanges() - before;
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(2 * result.updated);
    const stored = storedClusterIds();
    expect(stored.get("zz-late-asset")).toBe(stored.get(ids[0]!));
    expect(stored.get(ids[2]!)).toBeNull();
  });
});
