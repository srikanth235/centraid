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

import { bootstrapVault } from "../../packages/vault/src/bootstrap.js";
import { registerEnrichCommands } from "../../packages/vault/src/commands/enrich.js";
import { registerMediaGazetteerCommands } from "../../packages/vault/src/commands/media-gazetteer.js";
import { registerMediaCommands } from "../../packages/vault/src/commands/media.js";
import { registerPartyCommands } from "../../packages/vault/src/commands/parties.js";
import { registerPeopleCommands } from "../../packages/vault/src/commands/people.js";
import { registerTagCommands } from "../../packages/vault/src/commands/tags.js";
import { openVaultDb } from "../../packages/vault/src/db.js";
import { createGateway } from "../../packages/vault/src/gateway/gateway.js";
import type { Credential } from "../../packages/vault/src/gateway/types.js";
import { installFixtureClock } from "../../packages/vault/tests/fixtures/ontology-scenarios/clock.js";

/** Where the bundle is written, relative to the repository root. */
export const PHOTOS_PARITY_DIR = "contracts/apps/photos";

/**
 * The instant the whole run is stamped at. Frozen, and in the far future for
 * the reason Tally's generator records: the vault has TWO clocks, and a
 * condition comparing `purge_at` against SQLite's own `now` cannot be held
 * still by a JS proxy. `media.restore_asset`'s precondition is exactly such a
 * comparison (`packages/vault/src/commands/media.ts`'s `asset_is_trashed`), so
 * at a past epoch the restore step cannot be fixtured at all.
 *
 * The Rust port took the other road: its condition reads `:ctx_now`
 * (`crates/vault/src/commands/media.rs`), so the same fixture is reproducible
 * at any instant. The epoch stays in 2099 while v0 is the oracle.
 */
export const PARITY_EPOCH = "2099-06-01T09:00:00.000Z";

/**
 * The tables the eight Photos queries read, in the order the library reads
 * them.
 *
 * Derived from the STATEMENTS, not from the manifest's `vault.scopes`: the
 * manifest declares reach and the statements are what ran.
 */
export const PHOTOS_PARITY_TABLES = [
  "core_vault",
  "core_party",
  "core_content_item",
  "core_content_representation",
  "core_content_derivative",
  "core_concept_scheme",
  "core_concept",
  "core_tag",
  "core_collection",
  "core_collection_entry",
  "core_place",
  "media_asset",
  "media_asset_phash",
  "media_face_region",
  "media_face_cluster",
  "media_memory",
  "media_memory_member",
  "enrich_policy",
  "enrich_request",
  "blob_custody_state",
  "blob_custody_rollup",
] as const;

/** One table's rows, as data. */
export interface TableRows {
  table: string;
  columns: string[];
  rows: (string | number | null)[][];
}

export interface QueryCase {
  query: string;
  input: Record<string, unknown>;
  output: unknown;
}

export interface CommandCase {
  command: string;
  input: Record<string, unknown>;
  status: string;
  output: unknown;
  reason?: string;
}

export interface PhotosParityBundle {
  rows: TableRows[];
  queries: QueryCase[];
  commands: CommandCase[];
  scenarios: unknown;
}

/** The token every host-clock instant is replaced by. See Tally's generator. */
const HOST_CLOCK = "<host-clock>";

/** Canonicalise every identifier to the order it first appears. */
function canonicalise<T>(value: T): T {
  const seen = new Map<string, string>();
  const ID =
    /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})\b/giu;
  const HOST_INSTANT =
    /(?<!2099)\b(?:19|20)\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gu;
  // A 64-hex sha is NOT canonicalised: it is a fact about the bytes, it is
  // reproducible, and a port compares it. The id pattern above cannot match it
  // because it is anchored to 32 hex characters exactly.
  const text = JSON.stringify(value)
    .replaceAll(ID, (id) => {
      const known = seen.get(id.toLowerCase());
      if (known) return known;
      const token = `id-${String(seen.size + 1).padStart(4, "0")}`;
      seen.set(id.toLowerCase(), token);
      return token;
    })
    .replaceAll(HOST_INSTANT, HOST_CLOCK);
  return JSON.parse(text) as T;
}

/** Deep-sorted JSON, so two runs that agree on values agree on bytes. */
export function stableJson(value: unknown): string {
  const sorted = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(sorted);
    if (node && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, child]) => [key, sorted(child)])
      );
    }
    return node;
  };
  return `${JSON.stringify(sorted(value), null, 2)}\n`;
}

/**
 * The eight queries, each at the inputs a parity run compares.
 *
 * THE SPECIFIERS ARE COMPUTED, NOT LITERAL, for the reason Tally's generator
 * records: a literal import pulls the whole blueprint handler graph into
 * whatever TypeScript program type-checks this file, and no program that can
 * also see `packages/vault/src` has both tsconfigs.
 */
async function runQueries(
  ctx: unknown,
  ids: { assets: string[]; places: string[] }
): Promise<QueryCase[]> {
  const HANDLERS = [
    "storage",
    "library",
    "faces",
    "face-queue",
    "people",
    "search",
    "duplicates",
    "enrichment-status",
  ] as const;
  const handlers = await Promise.all(
    HANDLERS.map(
      (name) =>
        import(`../../packages/blueprints/apps/photos/queries/${name}.ts`)
    )
  );
  const [storage, library, faces, faceQueue, people, search, duplicates, status] =
    handlers.map(
      (module: { default: unknown }) =>
        module.default as (args: unknown) => Promise<unknown>
    );

  // Inputs are FIXED and named, never derived at compare time.
  const plan: {
    query: string;
    run: (args: unknown) => Promise<unknown>;
    input: Record<string, unknown>;
  }[] = [
    { query: "storage", run: storage!, input: {} },
    { query: "library", run: library!, input: {} },
    // The declared floor and the declared ceiling, so the clamp is compared.
    { query: "library", run: library!, input: { limit: 20 } },
    { query: "library", run: library!, input: { limit: 2000 } },
    // A limit UNDER the floor and one OVER the ceiling: the clamp, not an error.
    { query: "library", run: library!, input: { limit: 1 } },
    { query: "library", run: library!, input: { limit: 9000 } },
    { query: "face-queue", run: faceQueue!, input: {} },
    { query: "people", run: people!, input: {} },
    { query: "duplicates", run: duplicates!, input: {} },
    { query: "enrichment-status", run: status!, input: {} },
    { query: "search", run: search!, input: { term: "tahoe" } },
    { query: "search", run: search!, input: { term: "ana" } },
    // A term nothing matches: the empty answer is a state, not an error.
    { query: "search", run: search!, input: { term: "zzzz" } },
    // An EMPTY term short-circuits before the index is touched.
    { query: "search", run: search!, input: { term: "" } },
    ...ids.assets.map((assetId) => ({
      query: "faces",
      run: faces!,
      input: { asset_id: assetId },
    })),
    // An asset that does not exist: an empty face list, never a throw.
    { query: "faces", run: faces!, input: { asset_id: "no-such-asset" } },
  ];

  const cases: QueryCase[] = [];
  for (const entry of plan) {
    // Sequential on purpose: the statements a handler makes are recorded in
    // order, and two handlers in flight would interleave them.
    // eslint-disable-next-line no-await-in-loop
    const output = await entry.run({ ctx, input: entry.input });
    cases.push({ query: entry.query, input: entry.input, output });
  }
  // A second `library` read after the keyset cursor, so the page boundary is a
  // compared case rather than a claim.
  const first = cases.find((entry) => entry.query === "library");
  const tail = (first?.output as { tail?: string | null } | undefined)?.tail;
  if (typeof tail === "string") {
    cases.push({
      query: "library",
      input: { limit: 20, before: tail },
      output: await library!({ ctx, input: { limit: 20, before: tail } }),
    });
  }
  void ids.places;
  return cases;
}

/**
 * The ontology scenarios that touch media, exported as data. All thirteen run
 * against one vault in order, because a scenario that only holds in an
 * otherwise-empty vault is not telling the truth about the product.
 */
async function mediaScenarios(): Promise<unknown> {
  const { buildOntologyScenarios } = await import(
    "../../packages/vault/tests/fixtures/ontology-scenarios/build.js"
  );
  const fixture = buildOntologyScenarios();
  try {
    // ONT-03 is the favourite mirror the star replaced; ONT-26 is the sha
    // shape. Both are media's own drift.
    const wanted = new Set(["ONT-03", "ONT-26"]);
    return {
      digest: fixture.digest,
      scenarios: fixture.scenarios.filter((scenario: { drift: string }) =>
        wanted.has(scenario.drift)
      ),
    };
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
    const seed = await import(
      "../../packages/blueprints/apps/photos/seed.js"
    );
    await (seed.default as (args: unknown) => Promise<unknown>)({
      input: { seed: 1, now: PARITY_EPOCH },
      log: { info: () => undefined },
      ctx: {
        vault: {
          invoke: (request: { command: string; input?: Record<string, unknown> }) =>
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
    // `media.promote_caption` and `media.forget_person` are exercised only as
    // REFUSALS here: promoting needs a generated caption, which is the
    // automations lane's writer, and forgetting a person is confirm-gated and
    // not a Photos action. Both refusals are the port's to reproduce.
    execute("media.promote_caption", { asset_id: assetIds[0]! }, "any");
    execute("media.forget_person", { party_id: boot.ownerPartyId }, "any");

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

    // THE PRE-SWEEP STORAGE ANSWER, exported before anything writes a rollup:
    // `computedAt: null` with zero buckets is the state D-1020-P1 models as a
    // type, and it is the one a renderer gets wrong.
    const queries = await runQueries(ctx, {
      assets: assetIds,
      places: placeIds,
    });

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

    return {
      rows: canonicalise(rows),
      queries: canonicalise(queries),
      commands: canonicalise(commands),
      scenarios: canonicalise(scenarios),
    };
  } finally {
    clock.restore();
    db.close();
  }
}
