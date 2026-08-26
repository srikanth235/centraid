// `media.forget_person` (#724) — THE FACE-DELETE GATE that
// SECURITY.md's "Derived data and sensitive enrichments" section made a
// precondition for shipping face detection at all.
//
// The three obligations that section names get one describe block each:
// the cascade itself, the recovery scenario (an export taken after the forget
// must carry no trace), and the offline phone (a replica must be TOLD, which
// means the deletions have to reach the change log every replica catches up
// through).

import { beforeEach, describe, expect, test } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { FACE_REGION_TARGET_TYPE } from "../enrich/face-clusters.js";
import { encodeVector } from "../enrich/similarity.js";
import { createGateway } from "../gateway/gateway.js";
import type { Gateway } from "../gateway/gateway.js";
import { importVaultExport } from "../gateway/portability.js";
import type { Credential } from "../gateway/types.js";
import { uuidv7 } from "../ids.js";
import {
  currentReplicaLogState,
  readReplicaChanges,
} from "../replica/change-log.js";
import { registerEnrichCommands } from "./enrich.js";
import { registerMediaCommands } from "./media.js";
import { registerPartyCommands } from "./parties.js";

const PIXELS = [
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA3bvkkAAAACklEQVR4nGNgAAIAAAUAAen63NgAAAAASUVORK5CYII=",
];

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

interface Seeded {
  ana: string;
  sam: string;
  anaRegions: string[];
  samRegion: string;
}

describe("media.forget_person", () => {
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

  function invoke(command: string, input: Record<string, unknown>): unknown {
    const outcome = gw.invoke(owner, {
      command,
      input,
      purpose: "dpv:ServiceProvision",
    });
    expect(outcome, command).toMatchObject({ status: "executed" });
    return (outcome as { output: unknown }).output;
  }

  function addParty(name: string): string {
    return (
      invoke("core.add_party", { kind: "person", display_name: name }) as {
        party_id: string;
      }
    ).party_id;
  }

  function addAsset(index: number): string {
    return (
      invoke("media.add_asset", { data_uri: PIXELS[index] }) as {
        asset_id: string;
      }
    ).asset_id;
  }

  /** One face region plus the whole derived tail a real sweep leaves behind. */
  function addFace(
    regionId: string,
    assetId: string,
    state: "proposed" | "confirmed",
    partyId: string | null
  ): string {
    db.vault
      .prepare(
        `INSERT INTO media_face_region
           (region_id, asset_id, bbox_json, party_id, confidence,
            confirmed_by_party_id, review_state)
         VALUES (?, ?, '{"x":0.1,"y":0.1,"w":0.2,"h":0.2}', ?, 0.9, ?, ?)`
      )
      .run(
        regionId,
        assetId,
        partyId,
        state === "confirmed" ? boot.ownerPartyId : null,
        state
      );
    db.vault
      .prepare(
        `INSERT INTO enrich_embedding
           (embedding_id, target_type, target_id, model, dim, vector, created_at)
         VALUES (?, ?, ?, 'test-faces@1', 4, ?, '2026-08-01T00:00:00.000Z')`
      )
      .run(
        uuidv7(),
        FACE_REGION_TARGET_TYPE,
        regionId,
        encodeVector([0.5, 0.5, 0.5, 0.5])
      );
    db.vault
      .prepare(
        `INSERT INTO enrich_derivation
           (derivation_id, target_type, target_id, variant, capability, model,
            payload_json, produced_at)
         VALUES (?, ?, ?, 'face-embedding', 'faces', 'test-faces@1', NULL,
                 '2026-08-01T00:00:00.000Z')`
      )
      .run(uuidv7(), FACE_REGION_TARGET_TYPE, regionId);
    db.vault
      .prepare(
        `INSERT INTO media_face_cluster (region_id, cluster_id, computed_at)
         VALUES (?, ?, '2026-08-01T00:00:00.000Z')`
      )
      .run(regionId, regionId);
    return regionId;
  }

  /**
   * Ana on two photographs — one region she confirmed, one still proposed —
   * and Sam on a third, so every assertion can also say what was NOT touched.
   */
  function seed(): Seeded {
    const ana = addParty("Ana");
    const sam = addParty("Sam");
    const assets = [addAsset(0), addAsset(1), addAsset(2)];
    return {
      ana,
      sam,
      anaRegions: [
        addFace("r-ana-confirmed", assets[0]!, "confirmed", ana),
        addFace("r-ana-proposed", assets[1]!, "proposed", ana),
      ],
      samRegion: addFace("r-sam", assets[2]!, "confirmed", sam),
    };
  }

  /** Every row in the vault that still names `partyId` through a face. */
  function traces(
    vault: VaultDb["vault"],
    regionIds: readonly string[]
  ): {
    regions: number;
    vectors: number;
    stamps: number;
    clusters: number;
  } {
    const placeholders = regionIds.map(() => "?").join(",");
    const count = (sql: string): number =>
      Number((vault.prepare(sql).get(...regionIds) as { n: number }).n);
    return {
      regions: count(
        `SELECT count(*) AS n FROM media_face_region WHERE region_id IN (${placeholders})`
      ),
      vectors: count(
        `SELECT count(*) AS n FROM enrich_embedding
          WHERE target_type = 'media.face_region' AND target_id IN (${placeholders})`
      ),
      stamps: count(
        `SELECT count(*) AS n FROM enrich_derivation
          WHERE target_type = 'media.face_region' AND target_id IN (${placeholders})`
      ),
      clusters: count(
        `SELECT count(*) AS n FROM media_face_cluster WHERE region_id IN (${placeholders})`
      ),
    };
  }

  test("forgetting a person leaves no face row, no vector, no stamp and no grouping that names them", () => {
    const seeded = seed();
    expect(traces(db.vault, seeded.anaRegions)).toStrictEqual({
      regions: 2,
      vectors: 2,
      stamps: 2,
      clusters: 2,
    });

    const output = invoke("media.forget_person", { party_id: seeded.ana }) as {
      regions_forgotten: number;
      embeddings_forgotten: number;
    };

    expect(output).toMatchObject({
      regions_forgotten: 2,
      embeddings_forgotten: 2,
    });
    expect(traces(db.vault, seeded.anaRegions)).toStrictEqual({
      regions: 0,
      vectors: 0,
      stamps: 0,
      clusters: 0,
    });
    // The postcondition's own predicate, restated as the member's question:
    // does ANY face row still name Ana, through either column?
    const naming = db.vault
      .prepare(
        `SELECT count(*) AS n FROM media_face_region
          WHERE party_id = ? OR confirmed_by_party_id = ?`
      )
      .get(seeded.ana, seeded.ana) as { n: number };
    expect(Number(naming.n)).toBe(0);
    // …and Sam is entirely untouched. Forgetting one person is not a purge.
    expect(traces(db.vault, [seeded.samRegion])).toStrictEqual({
      regions: 1,
      vectors: 1,
      stamps: 1,
      clusters: 1,
    });
  });

  test("the person themself stays in the library — this forgets faces, not people", () => {
    const seeded = seed();
    invoke("media.forget_person", { party_id: seeded.ana });
    const party = db.vault
      .prepare("SELECT display_name FROM core_party WHERE party_id = ?")
      .get(seeded.ana) as { display_name: string } | undefined;
    expect(party?.display_name).toBe("Ana");
  });

  test("a destructive act leaves an audit trail: one provenance entry per forgotten region", () => {
    const seeded = seed();
    invoke("media.forget_person", { party_id: seeded.ana });
    const provenance = db.journal
      .prepare(
        `SELECT entity_id FROM consent_provenance
          WHERE entity_type = 'media.face_region' ORDER BY entity_id`
      )
      .all() as { entity_id: string }[];
    expect(provenance.map((row) => row.entity_id)).toStrictEqual(
      [...seeded.anaRegions].sort()
    );
  });

  test("forgetting twice is safe and honest — the second call finds nothing left", () => {
    const seeded = seed();
    invoke("media.forget_person", { party_id: seeded.ana });
    const second = invoke("media.forget_person", {
      party_id: seeded.ana,
    }) as { regions_forgotten: number };
    expect(second.regions_forgotten).toBe(0);
  });

  test("an unknown person is refused with a sentence, not a silent no-op", () => {
    const outcome = gw.invoke(owner, {
      command: "media.forget_person",
      input: { party_id: "nobody" },
      purpose: "dpv:ServiceProvision",
    });
    expect(outcome.status).toBe("failed");
  });

  // ── the recovery scenario (docs/recovery/backup-restore.md's checklist) ──
  test("an export taken after the forget carries no trace, so a restore cannot bring the faces back", () => {
    const seeded = seed();
    invoke("media.forget_person", { party_id: seeded.ana });

    const { artifact } = gw.exportVault(owner);
    // The blunt version of the claim first: the artifact is JSON, and none of
    // the forgotten region ids appear anywhere in it — not in a table, not in
    // a stamp, not in a skipped-table error string.
    const serialized = JSON.stringify(artifact.tables);
    for (const regionId of seeded.anaRegions)
      expect(serialized).not.toContain(regionId);

    const restored = openVaultDb();
    importVaultExport(restored, artifact);
    expect(traces(restored.vault, seeded.anaRegions)).toStrictEqual({
      regions: 0,
      vectors: 0,
      stamps: 0,
      clusters: 0,
    });
    // The restore is otherwise whole — Sam came back with everything.
    expect(traces(restored.vault, [seeded.samRegion])).toStrictEqual({
      regions: 1,
      vectors: 1,
      stamps: 1,
      clusters: 1,
    });
    restored.close();
  });

  // ── the offline phone (SECURITY.md: "every replica holding copies") ──
  test("every forgotten row is announced to replicas as a delete, so an offline phone loses them on reconnect", () => {
    const seeded = seed();
    const since = currentReplicaLogState(db.vault).watermark;

    invoke("media.forget_person", { party_id: seeded.ana });

    const page = readReplicaChanges(db.vault, { since });
    const deletes = page.changes.filter((change) => change.op === "delete");
    const deletedOf = (entity: string): string[] =>
      deletes
        .filter((change) => change.entity === entity)
        .map((change) => change.rowId)
        .sort();

    // A replica catches up by applying this log, so "the phone forgets" is
    // exactly "these rows are in the log as deletes" — for the boxes, the
    // vectors, the stamps AND the grouping, since a replica that kept any one
    // of the four would still be holding face data for a forgotten person.
    expect(deletedOf("media.face_region")).toStrictEqual(
      [...seeded.anaRegions].sort()
    );
    expect(deletedOf("media.face_cluster")).toStrictEqual(
      [...seeded.anaRegions].sort()
    );
    expect(deletedOf("enrich.embedding")).toHaveLength(2);
    expect(deletedOf("enrich.derivation")).toHaveLength(2);
    // Nothing of Sam's is announced — a replica is told about the forget, not
    // handed a reason to refetch a person who was never involved.
    expect(deletes.map((change) => change.rowId)).not.toContain(
      seeded.samRegion
    );
  });
});
