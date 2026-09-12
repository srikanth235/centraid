// Export Docs' parity fixtures from the v0 tree (#1020, wave 4 slot 4b,
// D-1020-D3-6).
//
// WHY GENERATED AND NOT TYPED. v0 is the executable specification. A parity
// fixture typed by hand is a fixture that says what its author believed the
// handlers do; this one says what they do. So the generator founds a fresh v0
// vault, runs the app's own demo seed plus a scripted command set through the
// REAL typed vault commands, then invokes all four Docs queries through the real
// handler path — the same statement-as-data through the same paged door — and
// writes what came back.
//
// WHAT IT WRITES, under `contracts/apps/docs/`:
//
//   rows.json       every row of every table the four queries read, by table
//   queries.json    {query, input, output} for all four, at fixed inputs
//   commands.json   the ordered `core.*` script, with `$from` references
//   scenarios.json  the ontology-scenario rows that touch documents
//
// THE SHARE PLANE IS SEEDED DIRECTLY, and that is the one place this generator
// writes rows no command wrote. `share.*` has three commands in v0 and all
// three are container-routed writes belonging to the peer plane, which is a
// LATER lane (census §Cross-lane: "`share_*` is read-only for Docs"). A fixture
// with no standing answers would make `shared_with` an always-empty column, and
// an always-empty column is exactly what a broken share fold looks like. So the
// rows are written with the vault's own DDL through `db.vault`, the way the
// ontology-scenario fixtures do, and the receipt says so.
//
// WHY ROWS AND NOT A `vault.db.gz` (D-1020-D3-11) — unchanged from Tally's and
// Photos' generators: `bootstrapVault` mints its ids as UUIDv7 off the clock, so
// a database file is not byte-reproducible; a compressed database is not
// reviewable; and Rust needs a schema to open anyway, which
// `contracts/schema/vault-ddl.sql` already is.
//
// TWO THINGS THIS GENERATOR MUST DO THAT PHOTOS' DID NOT.
//
// 1. **The commands file is a SCRIPT, not a log.** Tally's shape
//    (`crates/vault/tests/tally_commands.rs`): each step carries `{command,
//    input, output_keys}` with every id the run minted replaced by `{"$from":
//    "<step>.<key>"}`, so the Rust side can REPLAY it against its own ids and
//    compare the rows. Docs' whole surface is `core.*` and every id in it is
//    minted by the step before, which is what makes the replay possible at all.
// 2. **A nested folder and a grandparent share are in the corpus on purpose.**
//    The drive's folder rail is a tree and the share fold walks up it; a corpus
//    of flat folders cannot tell a working chain from a chain of length one,
//    which is the v0 defect this lane fixed at source (R-1020-35, the
//    `broader_concept_id` projection).
import { bootstrapVault } from "../../packages/vault/src/bootstrap.js";
import { registerDocumentCommands } from "../../packages/vault/src/commands/documents.js";
import { registerEnrichCommands } from "../../packages/vault/src/commands/enrich.js";
import { registerPartyCommands } from "../../packages/vault/src/commands/parties.js";
import { registerTagCommands } from "../../packages/vault/src/commands/tags.js";
import { openVaultDb } from "../../packages/vault/src/db.js";
import { createGateway } from "../../packages/vault/src/gateway/gateway.js";
import type { Credential } from "../../packages/vault/src/gateway/types.js";
import { installFixtureClock } from "../../packages/vault/tests/fixtures/ontology-scenarios/clock.js";
import {
  DOCS_PARITY_TABLES,
  PARITY_EPOCH,
  canonicaliseBundle,
  documentScenarios,
  loadHandlers,
} from "./docs-parity-bundle.js";
import type {
  CommandStep,
  DocsParityBundle,
  QueryCase,
  TableRows,
} from "./docs-parity-bundle.js";
import { seedSharePlane } from "./docs-parity-share-plane.js";

// The bundle's shape and its canonicalisation live next door; they are
// re-exported here so a caller has one import (`tests/quality/`'s oracle and the
// Rust side's README both name this file).
export {
  DOCS_PARITY_DIR,
  DOCS_PARITY_TABLES,
  PARITY_EPOCH,
  stableJson,
} from "./docs-parity-bundle.js";
export type {
  CommandStep,
  DocsParityBundle,
  QueryCase,
  TableRows,
} from "./docs-parity-bundle.js";

/** Build the whole bundle. Opens and closes its own vault. */
export async function buildDocsParity(): Promise<DocsParityBundle> {
  const scenarios = await documentScenarios();
  const db = openVaultDb();
  const clock = installFixtureClock(PARITY_EPOCH);
  try {
    const boot = bootstrapVault(db, {
      ownerName: "Priya",
      baseCurrency: "GBP",
    });
    const gateway = createGateway(db);
    registerPartyCommands(gateway);
    registerTagCommands(gateway);
    registerDocumentCommands(gateway);
    // `core.set_extracted_text` lives in the enrich pack even though it is a
    // `core.*` command: OCR text is what feeds a scanned document's FTS row.
    registerEnrichCommands(gateway);
    const owner: Credential = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };

    let step = 0;
    const commands: CommandStep[] = [];
    const outputs: Record<string, unknown>[] = [];

    /**
     * Run one command and record it as a REPLAYABLE step.
     *
     * `input` is written with `{"$from": …}` references already in it; the
     * resolved values are what this run sends, and the references are what the
     * fixture carries, so the Rust replay never sees an id this run minted.
     */
    const execute = <T extends Record<string, unknown>>(
      command: string,
      input: Record<string, unknown>,
      outputKeys: string[] = [],
      expect: "executed" | "any" = "executed"
    ): T => {
      const resolved = Object.fromEntries(
        Object.entries(input).map(([key, value]) => {
          const reference =
            value && typeof value === "object" && "$from" in value
              ? (value as { $from: string }).$from
              : null;
          if (reference === null) return [key, value];
          const [at, field] = reference.split(".");
          const produced = outputs[Number(at)]?.[field ?? ""];
          if (produced === undefined) {
            throw new Error(`step ${at} produced no \`${field}\``);
          }
          return [key, produced];
        })
      );
      const outcome = gateway.invoke(
        owner,
        { command, input: resolved },
        `docs-parity:${step++}`
      );
      const reason =
        (outcome as { reason?: string; message?: string }).reason ??
        (outcome as { message?: string }).message;
      // EVERY case is recorded, refusals included: a refusal is an answer the
      // port has to reproduce, and the ones this fixture trips on purpose are
      // the cases a port gets wrong.
      commands.push({
        command,
        input,
        output_keys: outputKeys,
        status: outcome.status,
        ...(reason === undefined ? {} : { reason }),
      });
      if (expect === "executed" && outcome.status !== "executed") {
        throw new Error(
          `${command} answered ${outcome.status}: ${reason ?? "no reason given"}`
        );
      }
      outputs.push(
        ((outcome as { output?: Record<string, unknown> }).output ??
          {}) as Record<string, unknown>
      );
      // Time moves between commands, or two writes share an instant and every
      // ordering claim over them says nothing.
      clock.advance(1_000);
      return (outcome as { output?: T }).output as T;
    };

    // THE DEMO SEED IS THE CORPUS. The app's own `seed.js` writes two folders
    // and three documents through the real commands, one of them with a second
    // version — exactly what a parity fixture wants: a corpus nobody typed.
    //
    // It is invoked OUTSIDE the script recorder, because its ids are the ones
    // the script then references by NAME below (read back off the rows), and a
    // seed recorded as steps would make the script a copy of the seed.
    const seed = await import("../../packages/blueprints/apps/docs/seed.js");
    await (seed.default as (args: unknown) => Promise<unknown>)({
      input: { now: PARITY_EPOCH },
      log: { info: () => undefined },
      ctx: {
        vault: {
          // THE CLOCK MOVES BETWEEN THE SEED'S OWN WRITES TOO, and that is not
          // cosmetic. The drive sorts newest-`created_at`-first and v0's
          // `toSorted` is STABLE, so documents sharing an instant keep the
          // order of the read that found them — which is by `document_id`, an
          // order the canonicaliser's `id-NNNN` tokens do not preserve. A
          // fixture whose page order depends on pre-canonicalisation uuids is
          // a fixture no port can be compared against; distinct instants make
          // the order a fact about the data.
          invoke: (request: {
            command: string;
            input?: Record<string, unknown>;
          }) => {
            const answer = gateway.invoke(owner, {
              command: request.command,
              input: request.input ?? {},
            });
            clock.advance(1_000);
            return Promise.resolve(answer);
          },
        },
      },
    });

    // THE SCRIPT. Every `core.*` command Docs invokes at least once, in an order
    // whose ids each come from the step before it — plus the refusals a port has
    // to reproduce.
    //
    // Step 0 and 1 build a TWO-LEVEL folder tree, because the drive's rail is a
    // tree and the share fold walks up it.
    const property = execute<{ folder_id: string }>(
      "core.create_folder",
      { name: "Property" },
      ["folder_id"]
    );
    execute<{ folder_id: string }>(
      "core.create_folder",
      { name: "Leases", parent_folder_id: { $from: "0.folder_id" } },
      ["folder_id"]
    );
    // A sibling name already taken: refused, and the port must refuse it too.
    execute("core.create_folder", { name: "Property" }, [], "any");
    const lease = execute<{ document_id: string; content_id: string }>(
      "core.add_document",
      {
        title: "Lease 2099",
        folder_id: { $from: "1.folder_id" },
        data_uri: `data:text/markdown;charset=utf-8,${encodeURIComponent(
          "# Lease 2099\n\nRent is due on the first.\n"
        )}`,
        extracted_text: "Rent is due on the first",
      },
      ["document_id", "content_id"]
    );
    // A FOLDER THAT STILL HOLDS A DOCUMENT DOES NOT DELETE, and it has to be
    // asked here rather than at the end of the script: by then the document has
    // moved to the drive's top level and the folder is empty.
    execute(
      "core.delete_folder",
      { folder_id: { $from: "1.folder_id" } },
      [],
      "any"
    );
    execute(
      "core.rename_document",
      { document_id: { $from: "3.document_id" }, title: "Lease 2099 (signed)" },
      ["document_id"]
    );
    // An edit mints a second version; a second identical edit mints none.
    execute(
      "core.edit_document",
      {
        document_id: { $from: "3.document_id" },
        body_text: "# Lease 2099\n\nRent is due on the second.\n",
      },
      ["document_id", "content_id"]
    );
    execute(
      "core.edit_document",
      {
        document_id: { $from: "3.document_id" },
        body_text: "# Lease 2099\n\nRent is due on the second.\n",
      },
      ["document_id", "content_id"]
    );
    // Back to the first version: a NEW forward occurrence, never a rewrite.
    execute(
      "core.restore_document_version",
      {
        document_id: { $from: "3.document_id" },
        content_id: { $from: "3.content_id" },
      },
      ["document_id", "content_id"]
    );
    // Already current: refused.
    execute(
      "core.restore_document_version",
      {
        document_id: { $from: "3.document_id" },
        content_id: { $from: "3.content_id" },
      },
      [],
      "any"
    );
    execute(
      "core.move_document",
      {
        document_id: { $from: "3.document_id" },
        folder_id: { $from: "0.folder_id" },
      },
      ["document_id"]
    );
    // An omitted folder is the drive's top level, not a refusal.
    execute("core.move_document", { document_id: { $from: "3.document_id" } }, [
      "document_id",
    ]);
    execute("core.star_document", { document_id: { $from: "3.document_id" } }, [
      "document_id",
    ]);
    // Idempotent: starring twice is one star.
    execute("core.star_document", { document_id: { $from: "3.document_id" } }, [
      "document_id",
    ]);
    execute(
      "core.unstar_document",
      { document_id: { $from: "3.document_id" } },
      ["document_id"]
    );
    const labelled = execute<{ tag_id: string }>(
      "core.tag_item",
      {
        subject_type: "core.document",
        subject_id: { $from: "3.document_id" },
        label: "Housing",
      },
      ["tag_id", "concept_id", "notation"]
    );
    execute("core.untag_item", { tag_id: { $from: "15.tag_id" } }, ["tag_id"]);
    // A tag that is gone: refused.
    execute("core.untag_item", { tag_id: { $from: "15.tag_id" } }, [], "any");
    execute(
      "core.set_extracted_text",
      {
        content_id: { $from: "3.content_id" },
        text: "Rent is due on the second",
      },
      ["content_id", "replaced"]
    );
    // Bytes nothing holds: refused.
    execute(
      "core.set_extracted_text",
      { content_id: "no-such-content", text: "x" },
      [],
      "any"
    );
    // The trash: keeps the folder tag, refuses a second trash, refuses a state
    // change, then restores.
    execute(
      "core.trash_document",
      { document_id: { $from: "3.document_id" } },
      ["document_id", "purge_at"]
    );
    execute(
      "core.trash_document",
      { document_id: { $from: "3.document_id" } },
      [],
      "any"
    );
    execute(
      "core.rename_document",
      { document_id: { $from: "3.document_id" }, title: "No" },
      [],
      "any"
    );
    execute(
      "core.restore_document",
      { document_id: { $from: "3.document_id" } },
      ["document_id"]
    );
    // A THROWAWAY FOLDER for the rename-then-delete pair, so `Leases` survives
    // in the final state: the drive's rail is a TREE, and a corpus whose every
    // folder is top-level cannot tell a working share chain from a chain of
    // length one (R-1020-35).
    const scratch = execute<{ folder_id: string }>(
      "core.create_folder",
      { name: "Scratch", parent_folder_id: { $from: "0.folder_id" } },
      ["folder_id"]
    );
    execute(
      "core.rename_folder",
      { folder_id: scratch.folder_id, name: "Scratch (old)" },
      ["folder_id"]
    );
    execute("core.delete_folder", { folder_id: scratch.folder_id }, [
      "folder_id",
    ]);
    // A SECOND DOCUMENT THAT STAYS FILED IN THE NESTED FOLDER, so the share
    // chain has two levels to walk in the final state.
    execute(
      "core.add_document",
      {
        title: "Deposit receipt",
        folder_id: { $from: "1.folder_id" },
        data_uri: `data:text/markdown;charset=utf-8,${encodeURIComponent(
          "# Deposit receipt\n\nThree hundred pounds, refundable.\n"
        )}`,
      },
      ["document_id", "content_id"]
    );
    // The drive's top level is not a folder, so neither gesture reaches it.
    const root = db.vault
      .prepare(
        `SELECT c.concept_id FROM core_concept c
           JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
          WHERE s.uri = 'https://centraid.dev/schemes/folders' AND c.notation = 'root'`
      )
      .get() as { concept_id: string } | undefined;
    if (!root) throw new Error("the folders scheme has no root concept");
    execute(
      "core.rename_folder",
      { folder_id: root.concept_id, name: "Everything" },
      [],
      "any"
    );
    // A trashed document, LEFT trashed, so the trash shelf and `empty-trash`
    // have something to act on.
    const spare = db.vault
      .prepare(
        `SELECT document_id FROM core_document
          WHERE title LIKE 'Renters%' ORDER BY document_id LIMIT 1`
      )
      .get() as { document_id: string } | undefined;
    if (!spare)
      throw new Error("the demo seed did not file the insurance policy");
    execute("core.trash_document", { document_id: spare.document_id }, [
      "document_id",
      "purge_at",
    ]);
    execute("core.empty_document_trash", {}, ["documents_released"]);
    // An empty-trash over the SAME row again: a no-op that still executes.
    execute("core.empty_document_trash", {}, ["documents_released"]);
    // A restore past its window: refused, because emptying the trash collapsed
    // the grace window onto a moment already in the past.
    execute(
      "core.restore_document",
      { document_id: spare.document_id },
      [],
      "any"
    );
    // An inline payload over the text budget: refused before anything is minted.
    execute(
      "core.add_document",
      {
        title: "Too long",
        data_uri: `data:text/plain;charset=utf-8,${"b".repeat(70_000)}`,
      },
      [],
      "any"
    );
    // Bytes nothing staged: refused.
    execute(
      "core.add_document",
      { title: "Absent", staged_sha: "cd".repeat(32) },
      [],
      "any"
    );
    void labelled;
    void property;
    void lease;

    // THE SHARE PLANE. Written directly — see the file header. One person and
    // one circle, one answer on the GRANDPARENT folder and one on a document,
    // one delivered pass and one still syncing, and one inbound subscription so
    // `shared_from` is a fact rather than an always-null column.
    seedSharePlane(db.vault, boot.ownerPartyId);

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

    const documentIds = (
      db.vault
        .prepare("SELECT document_id FROM core_document ORDER BY document_id")
        .all() as { document_id: string }[]
    ).map((row) => row.document_id);
    if (documentIds.length < 3) {
      throw new Error(
        "fewer than three documents: the drive cases would prove nothing"
      );
    }

    const handlers = await loadHandlers();
    const cases: QueryCase[] = [];
    const run = async (query: string, input: Record<string, unknown>) => {
      // Sequential on purpose: the statements a handler makes are recorded in
      // order, and two handlers in flight would interleave them.
      cases.push({
        query,
        input,
        output: await handlers[query]!({ ctx, input }),
      });
    };
    // THE DECLARED FLOOR AND CEILING, so the clamp is compared — plus one under
    // and one over, which is the clamp and not an error.
    await run("drive", {});
    await run("drive", { limit: 20 });
    await run("drive", { limit: 2000 });
    await run("drive", { limit: 1 });
    await run("drive", { limit: 9000 });
    await run("search", { term: "rent" });
    await run("search", { term: "tahoe" });
    // A term nothing matches, and an EMPTY term that short-circuits before the
    // index is touched.
    await run("search", { term: "zzzz" });
    await run("search", { term: "" });
    for (const documentId of documentIds) {
      // Sequential on purpose, the same reason Photos' generator records: the
      // statements a handler makes are recorded in order, and two handlers in
      // flight would interleave them.
      // eslint-disable-next-line no-await-in-loop
      await run("history", { document_id: documentId });
      // eslint-disable-next-line no-await-in-loop
      await run("activity", { document_id: documentId });
    }
    // A document that is not there: an empty answer, never a throw.
    await run("history", { document_id: "no-such-document" });
    await run("activity", { document_id: "no-such-document" });
    await run("history", {});

    const rows: TableRows[] = DOCS_PARITY_TABLES.map((table) => {
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
            // BYTES: `sha256` and `byte_size` are what a port compares.
            if (cell instanceof Uint8Array) return null;
            return (cell ?? null) as string | number | null;
          })
        ),
      };
    });

    return canonicaliseBundle({ rows, queries: cases, commands, scenarios });
  } finally {
    clock.restore();
    db.close();
  }
}
