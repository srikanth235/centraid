// Export Notes' parity fixtures from the v0 tree (#1020, wave 4 slot 4c,
// D-1020-D3-6).
//
// WHY GENERATED AND NOT TYPED. v0 is the executable specification. A parity
// fixture typed by hand is a fixture that says what its author believed the
// handlers do; this one says what they do. So the generator founds a fresh v0
// vault, runs the app's own demo seed plus a scripted command set through the
// REAL typed vault commands, then invokes all six Notes queries through the real
// handler path — the same statement-as-data through the same paged door — and
// writes what came back.
//
// WHAT IT WRITES, under `contracts/apps/notes/`:
//
//   rows.json       every row of every table the six queries read, by table
//   queries.json    {query, input, output} for all six, at fixed inputs
//   commands.json   the ordered script, with `$from` references
//   scenarios.json  the ontology-scenario rows that touch notes
//
// THE JOURNAL MARKER IS SEEDED DIRECTLY, and that is the one place this
// generator writes rows no command wrote. A People-journal entry is a
// `knowledge.note` carrying a concept from the people-journal scheme, and the
// command that writes it is People's (`people.*`, slot 4c's sibling lane) —
// `core.tag_item` writes into the TAGS scheme and cannot make one. A fixture
// with no journal entry would make the four exclusions always-vacuous, and an
// always-vacuous exclusion is exactly what a broken one looks like. So the rows
// are written with the vault's own DDL, the way the ontology-scenario fixtures
// do, and the receipt says so.
//
// WHY ROWS AND NOT A `vault.db.gz` (D-1020-D3-11) — unchanged from Tally's,
// Photos' and Docs' generators: `bootstrapVault` mints its ids as UUIDv7 off the
// clock, so a database file is not byte-reproducible; a compressed database is
// not reviewable; and Rust needs a schema to open anyway, which
// `contracts/schema/vault-ddl.sql` already is.
//
// ONE STEP IS `pending`. `send-to-tasks` invokes `schedule.add_task` and the
// Agenda/Tasks lane holds that schema (slot 4d); v0 answers it here and the Rust
// replay skips it by name, so the case lands the moment 4d does.
import { bootstrapVault } from "../../packages/vault/src/bootstrap.js";
import { registerAttachmentCommands } from "../../packages/vault/src/commands/attachments.js";
import { registerKnowledgeCommands } from "../../packages/vault/src/commands/knowledge.js";
import { registerLinkCommands } from "../../packages/vault/src/commands/links.js";
import { registerPartyCommands } from "../../packages/vault/src/commands/parties.js";
import { registerTagCommands } from "../../packages/vault/src/commands/tags.js";
import { openVaultDb } from "../../packages/vault/src/db.js";
import { createGateway } from "../../packages/vault/src/gateway/gateway.js";
import type { Credential } from "../../packages/vault/src/gateway/types.js";
import { installFixtureClock } from "../../packages/vault/tests/fixtures/ontology-scenarios/clock.js";
import {
  NOTES_PARITY_TABLES,
  PARITY_EPOCH,
  at,
  canonicaliseBundle,
  loadHandlers,
  noteScenarios,
} from "./notes-parity-bundle.js";
import type {
  CommandStep,
  NotesParityBundle,
  QueryCase,
  TableRows,
} from "./notes-parity-bundle.js";
import { runNotesScript } from "./notes-parity-script.js";

// The bundle's shape and its canonicalisation live next door; they are
// re-exported here so a caller has one import (`tests/quality/`'s oracle and the
// Rust side's README both name this file).
export {
  NOTES_PARITY_DIR,
  NOTES_PARITY_TABLES,
  PARITY_EPOCH,
  stableJson,
} from "./notes-parity-bundle.js";
export type {
  CommandStep,
  NotesParityBundle,
  QueryCase,
  TableRows,
} from "./notes-parity-bundle.js";

/** The scheme and notation a People-journal entry is marked with. */
const JOURNAL_SCHEME_URI = "https://centraid.dev/schemes/people-journal";
const JOURNAL_ENTRY_NOTATION = "entry";

/** Build the whole bundle. Opens and closes its own vault. */
export async function buildNotesParity(): Promise<NotesParityBundle> {
  const scenarios = await noteScenarios();
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
    registerKnowledgeCommands(gateway);
    registerLinkCommands(gateway);
    registerAttachmentCommands(gateway);
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
      expect: "executed" | "any" = "executed",
      pending?: string
    ): T => {
      const resolved = Object.fromEntries(
        Object.entries(input).map(([key, value]) => {
          const reference =
            value && typeof value === "object" && "$from" in value
              ? (value as { $from: string }).$from
              : null;
          if (reference === null) return [key, value];
          const [stepIndex, field] = reference.split(".");
          const produced = outputs[Number(stepIndex)]?.[field ?? ""];
          if (produced === undefined) {
            throw new Error(`step ${stepIndex} produced no \`${field}\``);
          }
          return [key, produced];
        })
      );
      const outcome = gateway.invoke(
        owner,
        { command, input: resolved },
        `notes-parity:${step++}`
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
        ...(pending === undefined ? {} : { pending }),
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

    // THE DEMO SEED IS THE CORPUS. The app's own `seed.js` writes two notebooks
    // and five notes through the real commands — exactly what a parity fixture
    // wants: a corpus nobody typed.
    //
    // It is invoked OUTSIDE the script recorder, because its ids are the ones
    // the script then references by NAME below (read back off the rows), and a
    // seed recorded as steps would make the script a copy of the seed.
    const seed = await import("../../packages/blueprints/apps/notes/seed.js");
    await (seed.default as (args: unknown) => Promise<unknown>)({
      input: { now: PARITY_EPOCH },
      log: { info: () => undefined },
      ctx: {
        vault: {
          // THE CLOCK MOVES BETWEEN THE SEED'S OWN WRITES TOO, and that is not
          // cosmetic. The library sorts newest-`updated_at`-first and v0's
          // `toSorted` is STABLE, so notes sharing an instant keep the order of
          // the read that found them — which is by `note_id`, an order the
          // canonicaliser's `id-NNNN` tokens do not preserve. A fixture whose
          // page order depends on pre-canonicalisation uuids is a fixture no
          // port can be compared against.
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

    const noteIds = (
      db.vault
        .prepare("SELECT note_id FROM knowledge_note ORDER BY note_id")
        .all() as { note_id: string }[]
    ).map((row) => row.note_id);
    if (noteIds.length < 5) {
      throw new Error("the demo seed wrote fewer than five notes");
    }
    const notebookIds = (
      db.vault
        .prepare(
          "SELECT collection_id FROM core_collection ORDER BY sort_order"
        )
        .all() as { collection_id: string }[]
    ).map((row) => row.collection_id);

    runNotesScript(execute, noteIds, notebookIds, db.vault);

    // THE JOURNAL MARKER — see the file header for why it is not a command.
    seedJournalMarker(db.vault, boot.ownerPartyId, at(noteIds, 3, "note"));

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
        search: (request: Parameters<typeof gateway.search>[1]) =>
          Promise.resolve(gateway.search(owner, request)),
        resolve: (request: Parameters<typeof gateway.resolveRefs>[1]) =>
          Promise.resolve(gateway.resolveRefs(owner, request)),
      },
    };

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
    await run("library", {});
    await run("library", { limit: 20 });
    await run("library", { limit: 2000 });
    await run("library", { limit: 1 });
    await run("library", { limit: 9000 });
    await run("journal", {});
    await run("journal", { limit: 20 });
    await run("search", { term: "cabin" });
    await run("search", { term: "chili" });
    await run("search", { term: "zzzz" });
    await run("search", { term: "" });
    await run("link-targets", { term: "cabin" });
    await run("link-targets", { term: "zzzz" });
    await run("link-targets", { term: "" });
    const allNotes = (
      db.vault
        .prepare("SELECT note_id FROM knowledge_note ORDER BY note_id")
        .all() as { note_id: string }[]
    ).map((row) => row.note_id);
    for (const noteId of allNotes) {
      // Sequential on purpose, the same reason Photos' generator records.
      // eslint-disable-next-line no-await-in-loop
      await run("note", { note_id: noteId });
      // eslint-disable-next-line no-await-in-loop
      await run("history", { note_id: noteId });
    }
    // A note that is not there, and an absent id: an empty answer, never a throw.
    await run("note", { note_id: "no-such-note" });
    await run("history", { note_id: "no-such-note" });
    await run("note", {});
    await run("history", {});

    const rows: TableRows[] = NOTES_PARITY_TABLES.map((table) => {
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

/**
 * Mark one note as a People-journal entry.
 *
 * The scheme, the marker concept and the tag edge — three rows no command in
 * this registry writes, because the command that writes them is People's. See
 * the file header.
 */
function seedJournalMarker(
  vault: ReturnType<typeof openVaultDb>["vault"],
  ownerPartyId: string,
  noteId: string
): void {
  const stamp = PARITY_EPOCH;
  vault
    .prepare(
      `INSERT INTO core_concept_scheme (scheme_id, uri, title, publisher, version, created_at)
       VALUES ('scheme-journal', ?, 'People journal', 'centraid', '1', ?)`
    )
    .run(JOURNAL_SCHEME_URI, stamp);
  vault
    .prepare(
      `INSERT INTO core_concept
         (concept_id, scheme_id, notation, pref_label, created_at, updated_at)
       VALUES ('concept-journal-entry', 'scheme-journal', ?, 'Journal entry', ?, ?)`
    )
    .run(JOURNAL_ENTRY_NOTATION, stamp, stamp);
  vault
    .prepare(
      `INSERT INTO core_tag
         (tag_id, target_type, target_id, concept_id, tagged_by_party_id,
          confidence, tagged_at, updated_at)
       VALUES ('tag-journal-entry', 'knowledge.note', ?, 'concept-journal-entry', ?,
               NULL, ?, ?)`
    )
    .run(noteId, ownerPartyId, stamp, stamp);
}
