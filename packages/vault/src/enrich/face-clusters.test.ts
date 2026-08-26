// Face grouping (#724) — behaviour, not mechanism. Every case here
// is an owner-visible claim: what a confirmation buys the next pass, what an
// answered proposal is protected from, what two different people must never
// become, and that a rebuild says the same thing twice.
//
// Vectors are hand-written and tiny. A face embedder's real geometry is not
// the subject: the subject is what this module does with distances, so the
// fixtures put the distances exactly where the assertion needs them.

import { beforeEach, describe, expect, test } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { registerEnrichCommands } from "../commands/enrich.js";
import { registerMediaCommands } from "../commands/media.js";
import { registerPartyCommands } from "../commands/parties.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { createGateway } from "../gateway/gateway.js";
import type { Gateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import { uuidv7 } from "../ids.js";
import {
  FACE_CLUSTER_MAX_DISTANCE,
  FACE_REGION_TARGET_TYPE,
  rebuildFaceClusters,
} from "./face-clusters.js";
import { encodeVector } from "./similarity.js";

const MODEL = "test-faces@1";

/** Distinct pixel data URIs so each mints its OWN asset (sha256 differs). */
const PIXELS = [
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA3bvkkAAAACklEQVR4nGNgAAIAAAUAAen63NgAAAAASUVORK5CYII=",
];

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

/**
 * A unit-ish vector at `angle` radians in the first two dimensions. Cosine
 * distance between two of them is `1 - cos(Δangle)`, so a fixture states the
 * separation it wants directly rather than by hand-tuned coordinates.
 */
function faceVector(angle: number): number[] {
  return [Math.cos(angle), Math.sin(angle), 0, 0];
}

/** The angular gap that lands two vectors just INSIDE a cosine threshold. */
function insideGap(threshold: number): number {
  return Math.acos(1 - threshold) * 0.5;
}

/** …and just outside it. */
function outsideGap(threshold: number): number {
  return Math.acos(1 - threshold) * 1.5;
}

describe("face grouping", () => {
  beforeEach(() => {
    db = openVaultDb();
    boot = bootstrapVault(db, { ownerName: "Priya" });
    gw = createGateway(db);
    registerMediaCommands(gw);
    registerEnrichCommands(gw);
    registerPartyCommands(gw);
    owner = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
  });

  function addAsset(index: number): string {
    const outcome = gw.invoke(owner, {
      command: "media.add_asset",
      input: { data_uri: PIXELS[index] },
      purpose: "dpv:ServiceProvision",
    });
    expect(outcome.status).toBe("executed");
    return (outcome as { status: "executed"; output: { asset_id: string } })
      .output.asset_id;
  }

  /** A proposed face region on `assetId` whose vector points at `angle`. */
  function addFace(
    regionId: string,
    assetId: string,
    angle: number,
    model = MODEL
  ): string {
    db.vault
      .prepare(
        `INSERT INTO media_face_region
           (region_id, asset_id, bbox_json, party_id, confidence,
            confirmed_by_party_id, review_state)
         VALUES (?, ?, '{"x":0.1,"y":0.1,"w":0.2,"h":0.2}', NULL, 0.9, NULL, 'proposed')`
      )
      .run(regionId, assetId);
    db.vault
      .prepare(
        `INSERT INTO enrich_embedding
           (embedding_id, target_type, target_id, model, dim, vector, created_at)
         VALUES (?, ?, ?, ?, 4, ?, '2026-08-01T00:00:00.000Z')`
      )
      .run(
        uuidv7(),
        FACE_REGION_TARGET_TYPE,
        regionId,
        model,
        encodeVector(faceVector(angle))
      );
    return regionId;
  }

  function addParty(name: string): string {
    const outcome = gw.invoke(owner, {
      command: "core.add_party",
      input: { kind: "person", display_name: name },
      purpose: "dpv:ServiceProvision",
    });
    expect(outcome.status).toBe("executed");
    return (outcome as { status: "executed"; output: { party_id: string } })
      .output.party_id;
  }

  function confirm(regionId: string, partyId: string): void {
    const outcome = gw.invoke(owner, {
      command: "media.answer_face_proposal",
      input: { region_id: regionId, answer: "confirm", party_id: partyId },
      purpose: "dpv:ServiceProvision",
    });
    expect(outcome.status).toBe("executed");
  }

  function answer(regionId: string, kind: "reject" | "dismiss"): void {
    const outcome = gw.invoke(owner, {
      command: "media.answer_face_proposal",
      input: { region_id: regionId, answer: kind },
      purpose: "dpv:ServiceProvision",
    });
    expect(outcome.status).toBe("executed");
  }

  function regionRows(): {
    region_id: string;
    party_id: string | null;
    review_state: string;
    confirmed_by_party_id: string | null;
  }[] {
    return db.vault
      .prepare(
        `SELECT region_id, party_id, review_state, confirmed_by_party_id
           FROM media_face_region ORDER BY region_id`
      )
      .all() as never;
  }

  function clusterRows(): { region_id: string; cluster_id: string }[] {
    return db.vault
      .prepare(
        "SELECT region_id, cluster_id FROM media_face_cluster ORDER BY region_id"
      )
      .all() as never;
  }

  test("a confirmed face teaches the next pass to ASK about the ones like it, and the owner's own answer is left exactly as they left it", () => {
    const ana = addParty("Ana");
    const a1 = addAsset(0);
    const a2 = addAsset(1);
    const anchor = addFace("r-anchor", a1, 0);
    const nearby = addFace(
      "r-nearby",
      a2,
      insideGap(FACE_CLUSTER_MAX_DISTANCE)
    );
    confirm(anchor, ana);
    const confirmedBefore = regionRows().find((r) => r.region_id === anchor);

    const result = rebuildFaceClusters(db.vault, {
      now: "2026-08-01T00:00:00.000Z",
    });

    expect(result.matched).toBe(1);
    const after = regionRows();
    // The candidate landed on the unnamed region — as a QUESTION. It is still
    // 'proposed', so it enters the review queue as "is this Ana?" and nothing
    // in the library yet claims that it is.
    expect(after.find((r) => r.region_id === nearby)).toMatchObject({
      party_id: ana,
      review_state: "proposed",
      confirmed_by_party_id: null,
    });
    // The owner's own row is untouched, byte for byte.
    expect(after.find((r) => r.region_id === anchor)).toStrictEqual(
      confirmedBefore
    );
    // A matched proposal is a named candidate, not a stranger group.
    expect(clusterRows().map((r) => r.region_id)).not.toContain(nearby);
  });

  test("a rejected or dismissed face is never proposed again, to anyone", () => {
    const ana = addParty("Ana");
    const a1 = addAsset(0);
    const a2 = addAsset(1);
    const a3 = addAsset(2);
    confirm(addFace("r-anchor", a1, 0), ana);
    const rejected = addFace(
      "r-rejected",
      a2,
      insideGap(FACE_CLUSTER_MAX_DISTANCE)
    );
    const dismissed = addFace(
      "r-dismissed",
      a3,
      insideGap(FACE_CLUSTER_MAX_DISTANCE)
    );
    answer(rejected, "reject");
    answer(dismissed, "dismiss");

    const result = rebuildFaceClusters(db.vault, {
      now: "2026-08-01T00:00:00.000Z",
    });

    expect(result.matched).toBe(0);
    const after = regionRows();
    // Both stay answered and both stay party-less — which is also what the
    // schema's own CHECK insists on, so a regression here would surface as a
    // constraint failure rather than as silently re-proposed strangers.
    expect(after.find((r) => r.region_id === rejected)).toMatchObject({
      review_state: "rejected",
      party_id: null,
    });
    expect(after.find((r) => r.region_id === dismissed)).toMatchObject({
      review_state: "dismissed",
      party_id: null,
    });
    expect(clusterRows()).toStrictEqual([]);
  });

  test("two different people never merge into one group at the shipped threshold", () => {
    const gap = outsideGap(FACE_CLUSTER_MAX_DISTANCE);
    const assets = [addAsset(0), addAsset(1), addAsset(2)];
    // Two faces of person A, two of person B — each pair tight, the pairs far.
    addFace("r-a1", assets[0]!, 0);
    addFace("r-a2", assets[1]!, insideGap(FACE_CLUSTER_MAX_DISTANCE) * 0.4);
    addFace("r-b1", assets[2]!, gap);
    addFace(
      "r-b2",
      assets[2]!,
      gap + insideGap(FACE_CLUSTER_MAX_DISTANCE) * 0.4
    );

    const result = rebuildFaceClusters(db.vault, {
      now: "2026-08-01T00:00:00.000Z",
    });

    expect(result.clusters).toBe(2);
    const byCluster = new Map<string, string[]>();
    for (const row of clusterRows()) {
      const members = byCluster.get(row.cluster_id) ?? [];
      members.push(row.region_id);
      byCluster.set(row.cluster_id, members);
    }
    // Cluster ids are the lowest member id — deterministic, never a mint.
    expect(
      [...byCluster.entries()].sort(([left], [right]) =>
        left.localeCompare(right)
      )
    ).toStrictEqual([
      ["r-a1", ["r-a1", "r-a2"]],
      ["r-b1", ["r-b1", "r-b2"]],
    ]);
  });

  test("a lone unmatched face is nobody's group", () => {
    addFace("r-alone", addAsset(0), 0);
    const result = rebuildFaceClusters(db.vault, {
      now: "2026-08-01T00:00:00.000Z",
    });
    expect(result.clusters).toBe(0);
    expect(clusterRows()).toStrictEqual([]);
  });

  test("a rebuild over unchanged data says the same thing and writes nothing", () => {
    const assets = [addAsset(0), addAsset(1)];
    addFace("r-1", assets[0]!, 0);
    addFace("r-2", assets[1]!, insideGap(FACE_CLUSTER_MAX_DISTANCE) * 0.4);

    const first = rebuildFaceClusters(db.vault, {
      now: "2026-08-01T00:00:00.000Z",
    });
    const firstRows = db.vault
      .prepare(
        "SELECT region_id, cluster_id, computed_at FROM media_face_cluster ORDER BY region_id"
      )
      .all();
    // A different clock on the second pass: a stable rebuild must not restamp
    // rows whose membership did not move, so `computed_at` stays where it was.
    const second = rebuildFaceClusters(db.vault, {
      now: "2027-01-01T00:00:00.000Z",
    });
    const secondRows = db.vault
      .prepare(
        "SELECT region_id, cluster_id, computed_at FROM media_face_cluster ORDER BY region_id"
      )
      .all();

    expect(first.clusters).toBe(1);
    expect(first.updated).toBe(2);
    expect(second.clusters).toBe(1);
    expect(second.updated).toBe(0);
    expect(secondRows).toStrictEqual(firstRows);
  });

  test("vectors from two different models are never compared", () => {
    const assets = [addAsset(0), addAsset(1)];
    // Identical directions, different embedders. Grouping them would be a
    // number with no meaning behind it.
    addFace("r-old", assets[0]!, 0, "test-faces@1");
    addFace("r-new", assets[1]!, 0, "test-faces@2");

    const result = rebuildFaceClusters(db.vault, {
      now: "2026-08-01T00:00:00.000Z",
    });

    expect(result.clusters).toBe(0);
    expect(clusterRows()).toStrictEqual([]);
  });

  test("a face on a trashed photograph leaves every group it was in", () => {
    const assets = [addAsset(0), addAsset(1)];
    addFace("r-1", assets[0]!, 0);
    addFace("r-2", assets[1]!, insideGap(FACE_CLUSTER_MAX_DISTANCE) * 0.4);
    rebuildFaceClusters(db.vault, { now: "2026-08-01T00:00:00.000Z" });
    expect(clusterRows()).toHaveLength(2);

    const trashed = gw.invoke(owner, {
      command: "media.delete_asset",
      input: { asset_id: assets[1] },
      purpose: "dpv:ServiceProvision",
    });
    expect(trashed.status).toBe("executed");

    const result = rebuildFaceClusters(db.vault, {
      now: "2026-08-02T00:00:00.000Z",
    });
    // One member left is not a group, so the projection empties rather than
    // keeping a group of one nobody can name.
    expect(result.clusters).toBe(0);
    expect(clusterRows()).toStrictEqual([]);
  });
});
