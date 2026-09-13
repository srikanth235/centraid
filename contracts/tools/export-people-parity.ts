// Export People's parity fixtures from the v0 tree (#1020, wave 4 slot 4c,
// D-1020-D3-6).
//
// WHY GENERATED AND NOT TYPED. v0 is the executable specification. A parity
// fixture typed by hand is a fixture that says what its author believed the
// handlers do; this one says what they do. So the generator founds a fresh v0
// vault, runs the app's own demo seed plus a scripted command set through the
// REAL typed vault commands, then invokes all seven People queries through the
// real handler path — the same statement-as-data through the same paged door —
// and writes what came back.
//
// WHAT IT WRITES, under `contracts/apps/people/`:
//
//   rows.json       every row of every table the seven queries read, by table
//   queries.json    {query, input, output} for all seven, at fixed inputs
//   commands.json   the ordered script: all 28 `people.*`, the 4 `social.*`
//                   and `core.merge_party`, with `$from` references
//   scenarios.json  the ontology-scenario rows that touch People
//
// THE SHARE PLANE IS SEEDED DIRECTLY, and it is the one part of the corpus no
// command wrote. `share_party_vault_binding` is written by the peer plane, which
// is a later lane (census §Cross-lane: `share.*` is read-only for People) — and
// a fixture with no bindings would make `linked` an always-false column, which
// is exactly what a broken sharing read looks like. So the rows are written with
// the vault's own DDL, the way the ontology-scenario fixtures do.
//
// WHY ROWS AND NOT A `vault.db.gz` (D-1020-D3-11) — unchanged from Tally's,
// Photos' and Docs' generators: `bootstrapVault` mints its ids as UUIDv7 off the
// clock, so a database file is not byte-reproducible; a compressed database is
// not reviewable; and Rust needs a schema to open anyway, which
// `contracts/schema/vault-ddl.sql` already is.
//
// TWO THINGS THIS GENERATOR DOES THAT NO EARLIER ONE HAD TO.
//
// 1. **The script covers a WHOLE SCHEMA plus a cross-schema primitive.** Docs'
//    sixteen actions are sixteen `core.*` commands; People's twenty-nine are
//    twenty-eight `people.*` and one `core.merge_party`, and the merge is the
//    LAST step on purpose: it deletes a party, so any case referring to that
//    party has to have run already.
// 2. **The civil-time cases are read in a stated zone.** `dashboard`'s Upcoming
//    rail sorts by `daysUntilMonthDay`, which reads the HOST's local midnight
//    (D-1020-PE7). The generator refuses to run outside UTC rather than
//    recording a fixture whose order depends on where it was generated.
import { bootstrapVault } from "../../packages/vault/src/bootstrap.js";
import { registerKnowledgeCommands } from "../../packages/vault/src/commands/knowledge.js";
import { registerMergeCommands } from "../../packages/vault/src/commands/merge.js";
import { registerPartyCommands } from "../../packages/vault/src/commands/parties.js";
import { registerPeopleCommands } from "../../packages/vault/src/commands/people.js";
import { registerSocialCommands } from "../../packages/vault/src/commands/social.js";
import { registerTagCommands } from "../../packages/vault/src/commands/tags.js";
import { openVaultDb } from "../../packages/vault/src/db.js";
import { createGateway } from "../../packages/vault/src/gateway/gateway.js";
import type { Credential } from "../../packages/vault/src/gateway/types.js";
import { installFixtureClock } from "../../packages/vault/tests/fixtures/ontology-scenarios/clock.js";
import {
  PARITY_EPOCH,
  PARITY_ZONE_OFFSET_MINUTES,
  canonicaliseBundle,
  dumpTables,
  loadHandlers,
  peopleScenarios,
  seedSharePlane,
} from "./people-parity-bundle.js";
import type {
  CommandStep,
  PeopleParityBundle,
  QueryCase,
} from "./people-parity-bundle.js";

// The bundle's shape and its canonicalisation live next door; they are
// re-exported here so a caller has one import (`tests/quality/`'s oracle and the
// Rust side's README both name this file).
export {
  PARITY_EPOCH,
  PARITY_TODAY,
  PARITY_ZONE_OFFSET_MINUTES,
  PEOPLE_PARITY_DIR,
  PEOPLE_PARITY_TABLES,
  stableJson,
} from "./people-parity-bundle.js";
export type {
  CommandStep,
  PeopleParityBundle,
  QueryCase,
  TableRows,
} from "./people-parity-bundle.js";

/** Build the whole bundle. Opens and closes its own vault. */
export async function buildPeopleParity(): Promise<PeopleParityBundle> {
  if (
    PARITY_ZONE_OFFSET_MINUTES !== -new Date(PARITY_EPOCH).getTimezoneOffset()
  ) {
    throw new Error(
      "this fixture's civil-time cases are read in the host's zone (D-1020-PE7); " +
        "run it with TZ=UTC, or the Upcoming rail's order is a fact about this machine"
    );
  }
  const scenarios = await peopleScenarios();
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
    registerPeopleCommands(gateway);
    registerSocialCommands(gateway);
    // `core.merge_party` is the ontology primitive `merge-people` invokes.
    registerMergeCommands(gateway);
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
        `people-parity:${step++}`
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

    // THE DEMO SEED IS THE CORPUS. The app's own `seed.js` writes four people,
    // three interactions, two important dates, two gift ideas and one debt
    // through the real commands — exactly what a parity fixture wants: a corpus
    // nobody typed.
    //
    // It is invoked OUTSIDE the script recorder, because its ids are the ones
    // the script then references by NAME below (read back off the rows), and a
    // seed recorded as steps would make the script a copy of the seed.
    const seed = await import("../../packages/blueprints/apps/people/seed.js");
    await (seed.default as (args: unknown) => Promise<unknown>)({
      input: { now: PARITY_EPOCH, seed: 1 },
      log: { info: () => undefined },
      ctx: {
        vault: {
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

    const seeded = (
      db.vault
        .prepare(
          `SELECT p.party_id, p.display_name FROM core_party p
             JOIN people_profile pr ON pr.party_id = p.party_id
            ORDER BY p.display_name`
        )
        .all() as { party_id: string; display_name: string }[]
    ).map((row) => row.party_id);
    if (seeded.length < 4) {
      throw new Error("the demo seed did not write four people");
    }
    const [chris, ray, jake, maya] = seeded as [string, string, string, string];

    // THE SCRIPT. Every `people.*` command at least once, the four `social.*`
    // ones, and `core.merge_party` last — plus the refusals a port has to
    // reproduce.
    const work = execute<{ list_id: string }>(
      "people.create_list",
      { name: "Work" },
      ["list_id"]
    );
    // A second list of the same name: refused, and the port must refuse it too.
    execute("people.create_list", { name: "Work" }, [], "any");
    execute("people.move_person", { party_id: chris, list_id: work.list_id }, [
      "party_id",
    ]);
    execute(
      "people.rename_list",
      { list_id: work.list_id, name: "Colleagues" },
      ["list_id"]
    );
    // A list that still holds somebody does not delete.
    execute("people.delete_list", { list_id: work.list_id }, [], "any");
    // Un-list, then the delete lands.
    execute("people.move_person", { party_id: chris }, ["party_id"]);
    execute("people.delete_list", { list_id: work.list_id }, ["list_id"]);
    const family = execute<{ list_id: string }>(
      "people.create_list",
      { name: "Family" },
      ["list_id"]
    );
    execute("people.move_person", { party_id: ray, list_id: family.list_id }, [
      "party_id",
    ]);
    // A list that is not there.
    execute(
      "people.move_person",
      { party_id: ray, list_id: "no-such-list" },
      [],
      "any"
    );

    execute("people.star_person", { party_id: ray }, ["party_id"]);
    // Idempotent: starring twice is one star.
    execute("people.star_person", { party_id: ray }, ["party_id"]);
    execute("people.star_person", { party_id: maya }, ["party_id"]);
    execute("people.unstar_person", { party_id: maya }, ["party_id"]);

    const edited = execute<{ revision_id: string }>(
      "people.edit_person",
      {
        party_id: chris,
        display_name: "Chris Okafor",
        role: "Design lead",
        nickname: "Chris",
        met: "At the studio open day",
      },
      ["party_id", "revision_id", "undo_until"]
    );
    execute("people.set_cadence", { party_id: chris, cadence_days: 21 }, [
      "party_id",
      "revision_id",
      "undo_until",
    ]);
    // The undo puts the old name back, and applies ONCE.
    execute(
      "people.undo_person",
      { party_id: chris, revision_id: edited.revision_id },
      ["party_id", "revision_id"]
    );
    execute(
      "people.undo_person",
      { party_id: chris, revision_id: edited.revision_id },
      [],
      "any"
    );

    execute(
      "people.add_note",
      { party_id: maya, text: "Loves the Tahoe photos." },
      ["party_id"]
    );
    const task = execute<{ task_id: string }>(
      "people.add_task",
      { party_id: maya, text: "Send the Denver dates" },
      ["task_id"]
    );
    execute("people.complete_task", { task_id: task.task_id }, [
      "task_id",
      "status",
    ]);
    execute("people.reopen_task", { task_id: task.task_id }, [
      "task_id",
      "status",
    ]);
    const anniversary = execute<{ date_id: string }>(
      "people.add_important_date",
      { party_id: maya, label: "Anniversary", month_day: "03-02" },
      ["date_id"]
    );
    execute("people.toggle_reminder", { date_id: anniversary.date_id }, [
      "date_id",
    ]);
    // February 31 is refused; February 29 is not.
    execute(
      "people.add_important_date",
      { party_id: maya, label: "Odd", month_day: "02-31" },
      [],
      "any"
    );
    execute(
      "people.add_important_date",
      { party_id: jake, label: "Birthday", month_day: "02-29" },
      ["date_id"]
    );
    execute(
      "people.add_relationship",
      { party_id: ray, name: "Edith", kind: "Wife" },
      ["relationship_id"]
    );
    execute(
      "people.add_relationship",
      { party_id: ray, name: "Biscuit", kind: "Pet", pet: "Dog" },
      ["relationship_id"]
    );
    const gift = execute<{ gift_id: string }>(
      "people.add_gift",
      { party_id: maya, text: "A print of the lake" },
      ["gift_id"]
    );
    execute("people.toggle_gift", { gift_id: gift.gift_id }, ["gift_id"]);
    // A task is not a gift.
    execute("people.toggle_gift", { gift_id: task.task_id }, [], "any");
    const debt = execute<{ debt_id: string }>(
      "people.add_debt",
      {
        party_id: chris,
        direction: "owed",
        amount_minor: 4_250,
        reason: "Print framing",
      },
      ["debt_id"]
    );
    execute("people.settle_debt", { debt_id: debt.debt_id }, ["debt_id"]);
    // A settled debt is not open.
    execute("people.settle_debt", { debt_id: debt.debt_id }, [], "any");
    execute(
      "people.log_interaction",
      { party_id: jake, kind: "Message", text: "Asked about the deposit." },
      ["interaction_id"]
    );
    execute(
      "people.add_journal_entry",
      {
        mood: "Quiet",
        text: "Nobody to call tonight.",
        entry_date: "2099-05-28",
      },
      ["entry_id"]
    );

    const channel = execute<{ channel_id: string }>(
      "people.save_contact_channel",
      {
        party_id: maya,
        kind: "phone",
        value: "+1 (415) 555-0100",
        label: "mobile",
        preferred: true,
      },
      ["channel_id", "normalized_value", "duplicate_party_ids"]
    );
    // THE SAME NUMBER ON SOMEBODY ELSE IS REPORTED, NEVER MERGED.
    execute(
      "people.save_contact_channel",
      { party_id: jake, kind: "phone", value: "415 555 0100" },
      ["channel_id", "normalized_value", "duplicate_party_ids"]
    );
    // The same number twice on one person: refused.
    execute(
      "people.save_contact_channel",
      { party_id: maya, kind: "phone", value: "+14155550100" },
      [],
      "any"
    );
    // A malformed address: refused with a sentence.
    execute(
      "people.save_contact_channel",
      { party_id: maya, kind: "email", value: "maya@example" },
      [],
      "any"
    );
    execute(
      "people.save_contact_channel",
      { party_id: maya, kind: "email", value: "Maya@Example.com" },
      ["channel_id", "normalized_value", "duplicate_party_ids"]
    );
    const deleted = execute<{ revision_id: string }>(
      "people.delete_contact_channel",
      { channel_id: channel.channel_id },
      ["channel_id", "revision_id", "undo_until"]
    );
    execute(
      "people.undo_contact_channel",
      { channel_id: channel.channel_id, revision_id: deleted.revision_id },
      ["channel_id"]
    );
    // A second undo of one snapshot: refused.
    execute(
      "people.undo_contact_channel",
      { channel_id: channel.channel_id, revision_id: deleted.revision_id },
      [],
      "any"
    );

    // THE `social` SCHEMA. A claimed handle in the register, a reach address as
    // a channel, a draft, a send and a read cursor.
    execute(
      "social.resolve_identity",
      { party_id: jake, scheme: "handle", value: "@jakeb" },
      ["party_id"]
    );
    execute(
      "social.resolve_identity",
      { party_id: jake, scheme: "email", value: "jake@example.com" },
      ["party_id"]
    );
    // The same address on somebody else is an identity fork: refused.
    execute(
      "social.resolve_identity",
      { party_id: maya, scheme: "email", value: "jake@example.com" },
      [],
      "any"
    );
    const draft = execute<{ message_id: string; thread_id: string }>(
      "social.draft_message",
      { body_text: "Sunday works for the cabin.", recipient_party_id: jake },
      ["message_id", "thread_id", "body_content_id"]
    );
    execute("social.send_message", { message_id: draft.message_id }, [
      "message_id",
      "delivery",
    ]);
    // A sent message is not a draft.
    execute("social.send_message", { message_id: draft.message_id }, [], "any");
    execute(
      "social.mark_thread_read",
      { thread_id: draft.thread_id, read_at: "2099-06-02T08:00:00.000Z" },
      ["thread_id"]
    );

    // THE TRASH, and a restore.
    execute("people.trash_person", { party_id: jake }, [
      "party_id",
      "revision_id",
      "undo_until",
    ]);
    // A trashed person is frozen.
    execute("people.edit_person", { party_id: jake, role: "No" }, [], "any");
    execute("people.restore_person", { party_id: jake }, ["party_id"]);
    // A DUPLICATE TO FOLD, and the merge LAST because it deletes a party.
    const duplicate = execute<{ party_id: string }>(
      "people.add_person",
      { display_name: "M. Alvarez", cadence_days: 30, role: "College friend" },
      ["party_id"]
    );
    execute(
      "people.add_note",
      { party_id: duplicate.party_id, text: "Same Maya, second card." },
      ["party_id"]
    );
    execute(
      "people.save_contact_channel",
      {
        party_id: duplicate.party_id,
        kind: "email",
        value: "maya.alvarez@example.com",
      },
      ["channel_id", "normalized_value", "duplicate_party_ids"]
    );
    // A person cannot be merged into themselves.
    execute(
      "core.merge_party",
      { survivor_party_id: maya, merged_party_id: maya },
      [],
      "any"
    );
    execute(
      "core.merge_party",
      { survivor_party_id: maya, merged_party_id: duplicate.party_id },
      ["survivor_party_id", "repointed"]
    );
    // A person who is gone cannot be merged again.
    execute(
      "core.merge_party",
      { survivor_party_id: maya, merged_party_id: duplicate.party_id },
      [],
      "any"
    );
    // And one trashed person left trashed, so the trash shelf is not empty.
    execute("people.trash_person", { party_id: chris }, [
      "party_id",
      "revision_id",
      "undo_until",
    ]);

    // THE SHARING PLANE. Written directly, next door: v0 has no command that
    // mints a binding, and at most one per party is live (finding PE-F6).
    seedSharePlane(db.vault, [maya, ray, jake]);

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
    // THE DECLARED FLOOR AND CEILING of `people.limit`, plus one under and one
    // over — which is the clamp and not an error — and the number v0's own
    // handler stops at (D-1020-PE4).
    await run("people", {});
    await run("people", { limit: 20 });
    await run("people", { limit: 10_000 });
    await run("people", { limit: 9_999 });
    await run("people", { limit: 1 });
    await run("people", { limit: 50_000 });
    await run("dashboard", {});
    await run("journal", {});
    await run("trash", {});
    for (const partyId of [maya, ray, jake, chris]) {
      // eslint-disable-next-line no-await-in-loop
      await run("person", { party_id: partyId });
      // eslint-disable-next-line no-await-in-loop
      await run("history", { party_id: partyId });
    }
    // A person who is not there, a person who was MERGED AWAY, and an empty id.
    await run("person", { party_id: "no-such-party" });
    await run("person", { party_id: duplicate.party_id });
    await run("person", {});
    await run("history", { party_id: "no-such-party" });
    await run("history", {});
    // THE THREE FTS INDEXES: a name, a role line, an owner's note, a term
    // nothing matches, and an empty term that short-circuits before the index.
    await run("search", { term: "alvarez" });
    await run("search", { term: "grandfather" });
    await run("search", { term: "tahoe" });
    await run("search", { term: "zzzz" });
    await run("search", { term: "" });

    const rows = dumpTables(db.vault);

    return canonicaliseBundle({ rows, queries: cases, commands, scenarios });
  } finally {
    clock.restore();
    db.close();
  }
}
