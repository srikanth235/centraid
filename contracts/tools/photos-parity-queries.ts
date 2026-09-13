// THE EIGHT QUERY HANDLERS AND THE INPUTS A PARITY RUN COMPARES (#1020, wave 4
// lane Photos).
//
// Split out of `export-photos-parity.ts` at the repository's 625-line ceiling:
// this half is the READ — which handler, at which input, in which order — and
// that file is the WRITE, the seed and the scripted command set that build the
// state these are read from.

import {
  FIXTURE_INSTANT_WINDOW_MS,
  PARITY_EPOCH,
} from "./photos-parity-bundle.js";
import type { QueryCase } from "./photos-parity-bundle.js";

/** Where the bundle is written, relative to the repository root. */

/** The eight handlers, by the name their file carries. */
export type Handlers = Record<string, (args: unknown) => Promise<unknown>>;

/**
 * Import the eight query handlers.
 *
 * THE SPECIFIERS ARE COMPUTED, NOT LITERAL, for the reason Tally's generator
 * records: a literal import pulls the whole blueprint handler graph into
 * whatever TypeScript program type-checks this file, and no program that can
 * also see `packages/vault/src` has both tsconfigs.
 */
export async function loadHandlers(): Promise<Handlers> {
  const NAMES = [
    "storage",
    "library",
    "faces",
    "face-queue",
    "people",
    "search",
    "duplicates",
    "enrichment-status",
  ] as const;
  const modules = await Promise.all(
    NAMES.map(
      (name) =>
        import(`../../packages/blueprints/apps/photos/queries/${name}.ts`)
    )
  );
  return Object.fromEntries(
    NAMES.map((name, index) => [
      name,
      (modules[index] as { default: unknown }).default as (
        args: unknown
      ) => Promise<unknown>,
    ])
  );
}

/**
 * The eight queries, each at the inputs a parity run compares.
 */
export async function runQueries(
  handlers: Handlers,
  ctx: unknown,
  ids: { assets: string[]; faceAssets: string[]; places: string[] }
): Promise<QueryCase[]> {
  const {
    storage,
    library,
    faces,
    "face-queue": faceQueue,
    people,
    search,
    duplicates,
    "enrichment-status": status,
  } = handlers;

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
    ...ids.faceAssets.map((assetId) => ({
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
  //
  // THE CURSOR IS NOT THE PAGE'S OWN `tail`, and that is a fact about the
  // corpus rather than a convenience. `tail` is the last live asset's
  // `taken_at`, which is `captured_at ?? created_at`; the three assets the
  // scripted command set adds carry no `captured_at`, so their `taken_at` is
  // SQLite's `created_at` — the host clock, different on every machine, and
  // they sort last because the host's year is far below the fixture epoch.
  // Feeding that tail back as an input would make this case's INPUT
  // unreproducible. So the cursor is the newest DATED asset's `taken_at`: a
  // real keyset read at a real page boundary, at an instant the fixture owns.
  const firstPage = cases.find((entry) => entry.query === "library")?.output as
    | { assets?: { taken_at?: string | null }[] }
    | undefined;
  const dated = (firstPage?.assets ?? [])
    .map((asset) => asset.taken_at)
    .filter((instant): instant is string => typeof instant === "string")
    .filter(
      (instant) =>
        Math.abs(Date.parse(instant) - Date.parse(PARITY_EPOCH)) <=
        FIXTURE_INSTANT_WINDOW_MS
    );
  const before = dated[Math.floor(dated.length / 2)];
  if (before === undefined) {
    throw new Error(
      "no dated asset in the first library page: the keyset case cannot be fixtured"
    );
  }
  cases.push({
    query: "library",
    input: { limit: 20, before },
    output: await library!({ ctx, input: { limit: 20, before } }),
  });
  void ids.places;
  return cases;
}
