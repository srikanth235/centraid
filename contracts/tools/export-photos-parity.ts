// Export Photos' parity fixtures from the v0 tree (#1020, wave 4 lane Photos,
// D-1020-D3-6).
//
// WHY GENERATED AND NOT TYPED. v0 is the executable specification. A parity
// fixture typed by hand is a fixture that says what its author believed the
// handlers do; this one says what they do. So the generator founds a fresh v0
// vault, runs the app's own demo seed plus a scripted command set through the
// REAL typed vault commands, then invokes every Photos query through the real
// handler path — the same statement-as-data through the same paged door — and
// writes what came back.
//
// WHAT IT WRITES, under `contracts/apps/photos/`:
//
//   rows.json       every row of every table the eight queries read, by table
//   queries.json    {query, input, output} for all eight, at fixed inputs
//   commands.json   {command, input, status, output} for the 20 `media.*` cases
//   scenarios.json  the ontology-scenario rows that touch media
//
// It does NOT write `sample/`: those bytes are copied from
// `packages/blueprints/apps/photos/sample` and their manifest is generated
// from the files themselves, because the coupling being recorded is a PIXEL
// DIMENSION and no handler answers it (census seam A3).
//
// ============================================================================
// THIS FILE IS COMMITTED AND HAS NOT BEEN RUN. Read this before trusting it.
// ============================================================================
//
// The lane that wrote it had 2.6 GB of disk free (`df -h /home/user`) with four
// Rust lanes sharing one 18 GB cargo target, and `bun install` in this
// worktree needs ~2.6 GB on its own. Running it would have filled the disk
// under three concurrent lanes. So the generator is committed unrun, with
// `contracts/apps/photos/manifest.json` declaring `fixtures:
// "pending-regeneration"` and `crates/apps/photos/tests/parity.rs` asserting
// that declaration — a green Rust suite therefore cannot be read as parity.
//
// What the owner has to run, in a worktree with disk:
//
//   bun install && bun run build
//   node node_modules/vitest/vitest.mjs run --config vitest.quality.config.ts \
//     tests/quality/photos-parity.contract.test.ts
//   bun run format && git diff --exit-code contracts/apps/photos
//
// The expected evidence: four JSON files appear under `contracts/apps/photos`,
// the second run of the same command writes nothing (`git diff --exit-code`
// passes), and the Rust side's `the_fixture_bundle_is_declared_pending...`
// test fails — which is the signal to replace it with the comparison and drop
// `fixtures` from the manifest.
//
// WHY ROWS AND NOT A `vault.db.gz` (D-1020-D3-11) — unchanged from Tally's
// generator: `bootstrapVault` mints its ids as UUIDv7 off the clock, so a
// database file is not byte-reproducible; a compressed database is not
// reviewable; and Rust needs a schema to open anyway, which
// `contracts/schema/vault-ddl.sql` already is.
//
// THREE THINGS THIS GENERATOR MUST DO THAT TALLY'S DID NOT.
//
// 1. **It is BYTE-BEARING.** Photos' assets carry real PNGs. The rows therefore
//    carry `content_uri` values that name the CAS (`blob:<sha>`) and never the
//    bytes; a BLOB cell is dropped to `null`, and `byte_size`/`sha256` are what
//    a port compares. The sample bytes themselves live in
//    `contracts/apps/photos/sample/` once, not inlined per row.
// 2. **The face queue's answers are part of the fixture.** Three of the twenty
//    command cases answer a proposal — confirm, reject, dismiss — because
//    `review_state` is the column the queue filters on and a fixture with only
//    `proposed` rows cannot show the filter working.
// 3. **The storage rollup is written by a SWEEP, not by a command.** There is no
//    `blob.*` command that writes `blob_custody_rollup`, so the generator runs
//    v0's own sweep once and then asserts the query's `computedAt` is non-null
//    — and ALSO exports the pre-sweep answer as its own case, because
//    "not counted yet" is the state the port models as a type (D-1020-P1) and
//    the one a renderer gets wrong.

import { refreshCustodyRollup } from "../../packages/vault/src/blob/custody-rollup.js";
import { bootstrapVault } from "../../packages/vault/src/bootstrap.js";
import { registerEnrichCommands } from "../../packages/vault/src/commands/enrich.js";
import { registerMediaGazetteerCommands } from "../../packages/vault/src/commands/media-gazetteer.js";
import { registerMediaCommands } from "../../packages/vault/src/commands/media.js";
import { registerPartyCommands } from "../../packages/vault/src/commands/parties.js";
import { registerPeopleCommands } from "../../packages/vault/src/commands/people.js";
import { registerSyncCommands } from "../../packages/vault/src/commands/sync.js";
import { registerTagCommands } from "../../packages/vault/src/commands/tags.js";
import { openVaultDb } from "../../packages/vault/src/db.js";
import { recomputeDuplicateClusters } from "../../packages/vault/src/enrich/clusters.js";
import { createGateway } from "../../packages/vault/src/gateway/gateway.js";
import type { Credential } from "../../packages/vault/src/gateway/types.js";
import { installFixtureClock } from "../../packages/vault/tests/fixtures/ontology-scenarios/clock.js";
import {
  PARITY_EPOCH,
  PHOTOS_PARITY_TABLES,
  canonicaliseBundle,
} from "./photos-parity-bundle.js";
import type {
  CommandCase,
  PhotosParityBundle,
  QueryCase,
  TableRows,
} from "./photos-parity-bundle.js";
import { loadHandlers, runQueries } from "./photos-parity-queries.js";

// The bundle's shape and its canonicalisation live next door; they are
// re-exported here so a caller has one import (`tests/quality/`'s oracle, and
// the Rust side's README, both name this file).
export {
  PARITY_EPOCH,
  PHOTOS_PARITY_DIR,
  PHOTOS_PARITY_TABLES,
  stableJson,
} from "./photos-parity-bundle.js";
export type {
  CommandCase,
  PhotosParityBundle,
  QueryCase,
  TableRows,
} from "./photos-parity-bundle.js";

/**
 * The ontology scenarios that touch media, exported as data. All thirteen run
 * against one vault in order, because a scenario that only holds in an
 * otherwise-empty vault is not telling the truth about the product.
 */
async function mediaScenarios(): Promise<unknown> {
  const { buildOntologyScenarios } =
    await import("../../packages/vault/tests/fixtures/ontology-scenarios/build.js");
  const fixture = buildOntologyScenarios();
  try {
    // THE THREE DRIFTS A PHOTOGRAPH IS SUBJECT TO:
    //
    //   ONT-22 — two byte-identical files keep separate histories, which is
    //            what stops a duplicate review from merging two members' rolls;
    //   ONT-26 — the invariant boundary the sha shape sits on;
    //   ONT-28 — one byte row read two ways, which is WHY a media type is a
    //            property of the owner and not of the bytes, and therefore why
    //            `crates/apps/photos/src/representations.rs` exists.
    //
    // A drift id that no longer exists must FAIL here rather than export one
    // scenario fewer: the earlier draft of this generator asked for `ONT-03`,
    // which the scenario set has not carried since the ids were renumbered, and
    // the filter answered quietly with the other one.
    const wanted = new Set(["ONT-22", "ONT-26", "ONT-28"]);
    const scenarios = fixture.scenarios.filter((scenario: { drift: string }) =>
      wanted.has(scenario.drift)
    );
    const found = new Set(
      scenarios.map((scenario: { drift: string }) => scenario.drift)
    );
    const missing = [...wanted].filter((drift) => !found.has(drift));
    if (missing.length > 0) {
      throw new Error(
        `the ontology scenario set carries no ${missing.join(", ")}: the media drifts moved`
      );
    }
    return { digest: fixture.digest, scenarios };
  } finally {
    fixture.db.close();
  }
}

/** Build the whole bundle. Opens and closes its own vault. */
export async function buildPhotosParity(): Promise<PhotosParityBundle> {
  const scenarios = await mediaScenarios();
  const db = openVaultDb();
  const clock = installFixtureClock(PARITY_EPOCH);
  try {
    const boot = bootstrapVault(db, {
      ownerName: "Priya",
      baseCurrency: "GBP",
    });
    const gateway = createGateway(db);
    registerPartyCommands(gateway);
    registerPeopleCommands(gateway);
    registerTagCommands(gateway);
    registerMediaCommands(gateway);
    registerMediaGazetteerCommands(gateway);
    registerEnrichCommands(gateway);
    // The demo seed stages its face PROPOSALS through the sync door
    // (`sync.stage_rows` with `kind: "enrich.faces"`,
    // `packages/blueprints/apps/photos/seed.js`), not through a `media.*`
    // command: a proposal is something that arrived, and `media_face_region`'s
    // `review_state` is what the queue filters on. Without these registered
    // the seed throws and the face queue has no corpus at all.
    registerSyncCommands(gateway);
    const owner: Credential = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };

    let step = 0;
    const commands: CommandCase[] = [];
    const execute = <T>(
      command: string,
      input: Record<string, unknown>,
      expect: "executed" | "any" = "executed"
    ): T => {
      const outcome = gateway.invoke(
        owner,
        { command, input },
        `photos-parity:${step++}`
      );
      const reason =
        (outcome as { reason?: string; message?: string }).reason ??
        (outcome as { message?: string }).message;
      // EVERY case is recorded, refusals included: a refusal is an answer the
      // port has to reproduce, and the ones this fixture trips on purpose —
      // a double delete, a purge of a live asset, a confirm naming nobody —
      // are the cases a port gets wrong.
      commands.push({
        command,
        // The inline bytes are NOT recorded: the sample manifest already names
        // them, and a base64 PNG per case would make the fixture unreadable.
        input: Object.fromEntries(
          Object.entries(input).filter(([key]) => key !== "data_uri")
        ),
        status: outcome.status,
        output: (outcome as { output?: unknown }).output ?? null,
        ...(reason === undefined ? {} : { reason }),
      });
      if (expect === "executed" && outcome.status !== "executed") {
        throw new Error(
          `${command} answered ${outcome.status}: ${reason ?? "no reason given"}`
        );
      }
      // Time moves between commands, or two writes share an instant and every
      // ordering claim over them says nothing.
      clock.advance(1_000);
      return (outcome as { output?: T }).output as T;
    };

    // THE DEMO SEED IS THE CORPUS. The app's own `seed.js` writes nineteen
    // assets through the real commands, which is exactly what a parity fixture
    // wants: a corpus nobody typed.
    const seed = await import("../../packages/blueprints/apps/photos/seed.js");
    await (seed.default as (args: unknown) => Promise<unknown>)({
      input: { seed: 1, now: PARITY_EPOCH },
      log: { info: () => undefined },
      ctx: {
        vault: {
          invoke: (request: {
            command: string;
            input?: Record<string, unknown>;
          }) =>
            Promise.resolve(
              gateway.invoke(owner, {
                command: request.command,
                input: request.input ?? {},
              })
            ),
        },
      },
    });

    const assetIds = (
      db.vault
        .prepare("SELECT asset_id FROM media_asset ORDER BY asset_id LIMIT 4")
        .all() as { asset_id: string }[]
    ).map((row) => row.asset_id);
    const placeIds = (
      db.vault
        .prepare("SELECT place_id FROM core_place ORDER BY place_id")
        .all() as { place_id: string }[]
    ).map((row) => row.place_id);
    // THE ASSETS THAT ACTUALLY CARRY FACES. `assetIds` above is the first four
    // by id and none of them has a region, so a `faces` case at those inputs
    // compares an empty answer to an empty answer. These are read AFTER the
    // command set, below, because the set answers and forgets regions.
    //
    // The seed's own two people, never the owner: the owner is the party the
    // script forgets.
    const personPartyIds = (
      db.vault
        .prepare(
          `SELECT party_id FROM core_party
            WHERE kind = 'person' AND party_id <> ?
            ORDER BY display_name, party_id`
        )
        .all(boot.ownerPartyId) as { party_id: string }[]
    ).map((row) => row.party_id);
    const regionIds = (
      db.vault
        .prepare("SELECT region_id FROM media_face_region ORDER BY region_id")
        .all() as { region_id: string }[]
    ).map((row) => row.region_id);

    // THE SCRIPTED COMMAND SET: every `media.*` command at least once, and the
    // refusals the port has to reproduce.
    execute("media.update_asset", {
      asset_id: assetIds[0]!,
      title: "A title the member typed",
      favorite: 1,
    });
    execute("media.set_archived", { asset_id: assetIds[1]!, archived: 1 });
    execute("media.set_favorite", { asset_id: assetIds[1]!, favorite: 0 });
    execute("media.name_place", {
      place_id: placeIds[0]!,
      name: "The cabin",
      kind: "home",
    });
    execute("media.set_place_gazetteer", {
      place_id: placeIds[1]!,
      name: "Truckee, CA",
      country: "US",
      distance_km: 4.2,
      source: "geonames-cities15000",
    });
    // A gazetteer MISS is a result, not an absence.
    execute("media.set_place_gazetteer", {
      place_id: placeIds[2]!,
      source: "geonames-cities15000",
    });
    execute("media.set_asset_place", {
      asset_id: assetIds[2]!,
      place_id: placeIds[0]!,
    });
    // An omitted place_id CLEARS it.
    execute("media.set_asset_place", { asset_id: assetIds[2]! });
    // The three answers, so `review_state` carries all four of its values.
    execute("media.answer_face_proposal", {
      region_id: regionIds[0]!,
      answer: "confirm",
      party_id: boot.ownerPartyId,
    });
    execute("media.answer_face_proposal", {
      region_id: regionIds[1]!,
      answer: "reject",
    });
    execute("media.answer_face_proposal", {
      region_id: regionIds[2]!,
      answer: "dismiss",
    });
    // The union rule, refused: a confirm naming nobody.
    execute(
      "media.answer_face_proposal",
      { region_id: regionIds[3]!, answer: "confirm" },
      "any"
    );
    // THE FACE-DELETE GATE, HERE AND NOT AT THE END OF THE SET, because of
    // what it deletes. `media.forget_person` removes every region
    // `WHERE party_id = :party_id OR confirmed_by_party_id = :party_id`
    // (`packages/vault/src/commands/media.ts`'s `FORGET_PERSON`, #724 W5) —
    // both party columns, deliberately — and the only credential this fixture
    // has is the owner's, so the owner is the `confirmed_by_party_id` of EVERY
    // confirmation in the vault. Run last, it would erase every confirmed
    // region regardless of whose face it is, and the bundle's final state would
    // carry no confirmed match at all: `people` — the query that lists only
    // confirmed parties — would answer empty for a reason that is an artefact
    // of this script rather than a fact about the port. Run here, it erases the
    // confirm above (the owner's own face: `regions_forgotten: 1`, the cascade
    // this command exists for) and the confirm below survives it.
    //
    // That the owner forgetting THEMSELF takes other people's confirmed faces
    // with them is v0's answer, is reproduced by the port, and is a question in
    // the receipt rather than a silent "deliberate".
    execute("media.forget_person", { party_id: boot.ownerPartyId });
    // A CONFIRMED REGION IN THE FINAL STATE, named to one of the seed's two
    // people rather than to the owner.
    execute("media.answer_face_proposal", {
      region_id: regionIds[4]!,
      answer: "confirm",
      party_id: personPartyIds[0]!,
    });
    const album = execute<{ album_id: string }>("media.create_album", {
      title: "A second album",
    });
    execute("media.add_to_album", {
      album_id: album.album_id,
      asset_id: assetIds[0]!,
    });
    // Already a member: a receipted refusal, not a constraint name.
    execute(
      "media.add_to_album",
      { album_id: album.album_id, asset_id: assetIds[0]! },
      "any"
    );
    execute("media.set_album_cover", {
      album_id: album.album_id,
      asset_id: assetIds[0]!,
    });
    execute("media.rename_album", {
      album_id: album.album_id,
      title: "Renamed",
    });
    execute("media.remove_from_album", {
      album_id: album.album_id,
      asset_id: assetIds[0]!,
    });
    const deleted = execute<{ revision_id: string }>("media.delete_album", {
      album_id: album.album_id,
    });
    execute("media.restore_album", {
      album_id: album.album_id,
      revision_id: deleted.revision_id,
    });
    execute("media.delete_asset", { asset_id: assetIds[3]! });
    // A double delete: refused, and the port must refuse it the same way.
    execute("media.delete_asset", { asset_id: assetIds[3]! }, "any");
    // A trashed asset is not editable (#916, BUG-7).
    execute(
      "media.set_favorite",
      { asset_id: assetIds[3]!, favorite: 1 },
      "any"
    );
    execute("media.restore_asset", { asset_id: assetIds[3]! });
    // A purge of a LIVE asset: refused.
    execute("media.purge_asset", { asset_id: assetIds[3]! }, "any");
    execute("media.delete_asset", { asset_id: assetIds[3]! });
    execute("media.purge_asset", { asset_id: assetIds[3]! });
    execute("enrich.request_enrichment", {
      entity_type: "media.asset",
      reason: "manual",
      capability: "faces",
    });
    // A manual ask with no capability: refused, because an untagged ask reads
    // as consent for every enricher.
    execute(
      "enrich.request_enrichment",
      { entity_type: "media.asset", reason: "manual" },
      "any"
    );
    // `media.promote_caption` is exercised only as a REFUSAL: promoting needs a
    // generated caption, which is the automations lane's writer.
    execute("media.promote_caption", { asset_id: assetIds[0]! }, "any");

    const ctx = {
      vault: {
        page: (request: {
          query: Parameters<typeof gateway.page>[1];
          limit: number;
          after?: { sortKey: string; pk: string };
        }) =>
          Promise.resolve(
            gateway.page(owner, request.query, {
              limit: request.limit,
              ...(request.after ? { after: request.after } : {}),
            })
          ),
        invoke: (request: {
          command: string;
          input?: Record<string, unknown>;
        }) =>
          Promise.resolve(
            gateway.invoke(owner, {
              command: request.command,
              input: request.input ?? {},
            })
          ),
        search: (request: { entity: string; query: string; limit: number }) =>
          Promise.resolve(gateway.search(owner, request)),
      },
    };

    // Read after the command set, which answers and forgets regions: the cases
    // must name the assets that carry a face in the FINAL state.
    const faceAssetIds = (
      db.vault
        .prepare(
          `SELECT DISTINCT asset_id FROM media_face_region ORDER BY asset_id LIMIT 4`
        )
        .all() as { asset_id: string }[]
    ).map((row) => row.asset_id);
    if (faceAssetIds.length < 3) {
      throw new Error(
        "fewer than three assets carry a face region: the faces cases would prove nothing"
      );
    }

    const handlers = await loadHandlers();

    // THE PRE-SWEEP STORAGE ANSWER, read before anything writes a rollup:
    // `computedAt: null` with zero buckets is the state D-1020-P1 models as a
    // type, and it is the one a renderer gets wrong. It is the ONE case marked
    // `phase: "unswept"`, because the rows beside it are the swept state.
    const unswept: QueryCase = {
      query: "storage",
      input: {},
      output: await handlers.storage!({ ctx, input: {} }),
      phase: "unswept",
    };

    // THE TWO SWEEPS, run here because NO COMMAND WRITES WHAT THEY WRITE and
    // two of the eight queries read only what they wrote:
    //
    // - `duplicates` reads `media_asset_phash.cluster_id IS NOT NULL`, and the
    //   column is the standing sweep's (`recomputeDuplicateClusters`, union-find
    //   over Hamming ≤ 6 with the group's lowest `asset_id` as the id). Without
    //   the sweep the query answers `{clusters: []}` for every corpus, which
    //   would have made the fixture agree with a port that does nothing —
    //   D-1020-P3's whole point is that the app only READS this id.
    // - `storage` reads `blob_custody_rollup`, which `refreshCustodyRollup`
    //   writes. The corpus carries no `blob_custody_state` rows (custody is the
    //   replica's writer, not a `media.*` command), so the swept buckets are
    //   still zero — and that is exactly the pair worth fixturing: two storage
    //   answers whose ONLY difference is `computedAt`, which is the difference
    //   between "nothing to free" and "not counted yet".
    const clustered = recomputeDuplicateClusters(db.vault);
    if (clustered.clustered === 0) {
      throw new Error(
        "the duplicate sweep clustered nothing: the duplicates case would prove nothing"
      );
    }
    refreshCustodyRollup(db);

    const queries = [
      unswept,
      ...(await runQueries(handlers, ctx, {
        assets: assetIds,
        faceAssets: faceAssetIds,
        places: placeIds,
      })),
    ];

    const rows: TableRows[] = PHOTOS_PARITY_TABLES.map((table) => {
      const columns = (
        db.vault.prepare(`PRAGMA table_info(${table})`).all() as {
          name: string;
        }[]
      ).map((column) => column.name);
      const fetched = db.vault
        .prepare(
          `SELECT ${columns.join(", ")} FROM ${table} ORDER BY ${columns[0]}`
        )
        .all() as Record<string, string | number | null>[];
      return {
        table,
        columns,
        rows: fetched.map((row) =>
          columns.map((column) => {
            const cell: unknown = row[column];
            // A BLOB reaches here as a Uint8Array. THE FIXTURE CARRIES NO
            // BYTES: the sample manifest names them, `sha256` and `byte_size`
            // are what a port compares, and a base64 PNG per row would make
            // the diff unreadable.
            if (cell instanceof Uint8Array) return null;
            return (cell ?? null) as string | number | null;
          })
        ),
      };
    });

    return canonicaliseBundle({ rows, queries, commands, scenarios });
  } finally {
    clock.restore();
    db.close();
  }
}
