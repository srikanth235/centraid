// THE SCHEDULE CORPUS: one founded v0 vault, and the script both apps' parity
// fixtures are read from (#1020, wave 4 slot 4d).
//
// The two generators share this because they share the schema: Tasks reads
// `schedule_task`, Agenda reads `core_event` and `schedule_recurrence_exception`
// and `schedule_task` (the grid's due-work shelf), and both go through the SAME
// sixteen typed `schedule.*` commands. A second copy would be a second corpus,
// and the two apps' fixtures would stop describing one vault.

import { bootstrapVault } from "../../packages/vault/src/bootstrap.js";
import { registerAttachmentCommands } from "../../packages/vault/src/commands/attachments.js";
import { registerPartyCommands } from "../../packages/vault/src/commands/parties.js";
import { registerScheduleCommands } from "../../packages/vault/src/commands/schedule.js";
import { registerTagCommands } from "../../packages/vault/src/commands/tags.js";
import { registerTaskCommands } from "../../packages/vault/src/commands/tasks.js";
import { openVaultDb } from "../../packages/vault/src/db.js";
import { createGateway } from "../../packages/vault/src/gateway/gateway.js";
import type { Credential } from "../../packages/vault/src/gateway/types.js";
import { installFixtureClock } from "../../packages/vault/tests/fixtures/ontology-scenarios/clock.js";
import { PARITY_EPOCH, loadCtxTime } from "./schedule-parity-bundle.js";
import type { CommandStep } from "./schedule-parity-bundle.js";

/** What a corpus run hands its caller. */
export interface Corpus {
  db: ReturnType<typeof openVaultDb>;
  gateway: ReturnType<typeof createGateway>;
  owner: Credential;
  ownerPartyId: string;
  calendarId: string;
  clock: ReturnType<typeof installFixtureClock>;
  commands: CommandStep[];
  /** Run one command and record it as a REPLAYABLE step. */
  execute: <T extends Record<string, unknown>>(
    command: string,
    input: Record<string, unknown>,
    outputKeys?: string[],
    expect?: "executed" | "any"
  ) => T;
  /** The handler context, `vault` and `time`. */
  ctx: Record<string, unknown>;
  close: () => void;
}

/**
 * Found a vault, register the command packs both apps reach, and hand back a
 * recorder.
 *
 * The packs: `schedule.*` (all sixteen, through
 * `registerScheduleCommands`, which also registers the organize and project
 * halves), `schedule.add_task` and its four siblings through
 * `registerTaskCommands`, plus `core.*`'s party, tag and attachment packs,
 * because Tasks' `add-tag` and both apps' `attach` are `core.*` actions.
 */
export async function openCorpus(): Promise<Corpus> {
  const db = openVaultDb();
  const clock = installFixtureClock(PARITY_EPOCH);
  const boot = bootstrapVault(db, { ownerName: "Priya", baseCurrency: "GBP" });
  const gateway = createGateway(db);
  registerScheduleCommands(gateway);
  registerTaskCommands(gateway);
  registerPartyCommands(gateway);
  registerTagCommands(gateway);
  registerAttachmentCommands(gateway);
  const owner: Credential = {
    kind: "device",
    deviceId: boot.deviceId,
    deviceKey: boot.deviceKey,
  };
  // Events need a calendar and no command mints one — `bootstrapVault` seeds a
  // private "Personal" calendar so the schema works out of the box
  // (`bootstrap.ts:150`-`:155`). Discover it; never hardcode the id.
  const calendar = db.vault
    .prepare(
      "SELECT calendar_id FROM schedule_calendar ORDER BY calendar_id LIMIT 1"
    )
    .get() as { calendar_id: string } | undefined;
  if (!calendar) throw new Error("the founded vault has no calendar");

  let step = 0;
  const outputs: Record<string, unknown>[] = [];
  const commands: CommandStep[] = [];
  const execute = <T extends Record<string, unknown>>(
    command: string,
    input: Record<string, unknown>,
    outputKeys: string[] = [],
    expect: "executed" | "any" = "executed"
  ): T => {
    // THE RESOLVER WALKS ARRAYS TOO. `attendee_party_ids: [{"$from": …}]` is
    // a reference inside a list, and a top-level-only resolver leaves the
    // object in the payload, where the command's input schema refuses it —
    // which is what a fixture that silently skipped a step would look like.
    const resolveValue = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(resolveValue);
      if (value && typeof value === "object") {
        if ("$from" in value) {
          const reference = (value as { $from: string }).$from;
          const [at, field] = reference.split(".");
          const produced = outputs[Number(at)]?.[field ?? ""];
          if (produced === undefined) {
            throw new Error(`step ${at} produced no \`${field}\``);
          }
          return produced;
        }
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(
            ([key, child]) => [key, resolveValue(child)]
          )
        );
      }
      return value;
    };
    const resolved = resolveValue(input) as Record<string, unknown>;
    const outcome = gateway.invoke(
      owner,
      { command, input: resolved },
      `schedule-parity:${step++}`
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

  const time = await loadCtxTime();
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
      invoke: (request: { command: string; input?: Record<string, unknown> }) =>
        Promise.resolve(
          gateway.invoke(owner, {
            command: request.command,
            input: request.input ?? {},
          })
        ),
      search: (request: { entity: string; query: string; limit: number }) =>
        Promise.resolve(gateway.search(owner, request)),
      resolve: (request: { refs: { type: string; id: string }[] }) =>
        Promise.resolve(gateway.resolve(owner, request)),
    },
    time,
  };

  return {
    db,
    gateway,
    owner,
    ownerPartyId: boot.ownerPartyId,
    calendarId: calendar.calendar_id,
    clock,
    commands,
    execute,
    ctx,
    close: () => {
      clock.restore();
      db.close();
    },
  };
}

/**
 * THE TASK SCRIPT, shared by both fixtures.
 *
 * Tasks reads it as its whole corpus; Agenda reads the rows it leaves behind
 * as the calendar grid's due-work shelf. Every case here is one a port gets
 * wrong in a different way:
 *
 * - a **project with a section**, and a task filed in the section of ANOTHER
 *   project — refused by the model, with the model's own sentence (ONT-26);
 * - a **family**: one open parent with two open children and one done child,
 *   so `done_children` counts and the nesting is not a guess;
 * - a **completed parent with an unfinished child**, which is the promotion
 *   rule and the only reason `nestTaskFamilies` exists;
 * - a **cancelled task**, whose `completed_at` is NULL — the nullable sort
 *   column lane V's refusal is about;
 * - an **undated task**, so the board's "nulls last" is a fact rather than a
 *   claim;
 * - a **repeating task in a DST zone**, whose missed-period collapse and next
 *   due date are wrong by an hour if the reader spells its zone column wrong;
 * - `due_at: "banana"` and `FREQ=MONTHLY;BYSETPOS=-1`, both refused at the
 *   write boundary rather than stored (ONT-31, D-1020-S1).
 */
export function runTaskScript(corpus: Corpus): void {
  const { execute } = corpus;
  const house = execute<{ project_id: string }>(
    "schedule.save_project",
    { name: "House", area: "Home", color: "#2EA098", sort_order: 1 },
    ["project_id"]
  );
  const work = execute<{ project_id: string }>(
    "schedule.save_project",
    { name: "Work", sort_order: 2 },
    ["project_id"]
  );
  const kitchen = execute<{ section_id: string }>(
    "schedule.save_section",
    { project_id: { $from: "0.project_id" }, name: "Kitchen", sort_order: 1 },
    ["section_id"]
  );
  // A SAVE IS AN UPSERT: the same id again renames rather than being refused.
  execute(
    "schedule.save_project",
    {
      project_id: { $from: "0.project_id" },
      name: "House and garden",
      sort_order: 1,
    },
    ["project_id"]
  );

  const trip = execute<{ task_id: string }>(
    "schedule.add_task",
    {
      title: "Plan the Tahoe trip",
      description: "Long weekend at the lake.",
      due_at: "2099-06-08T09:00:00.000Z",
      priority: 6,
    },
    ["task_id"]
  );
  execute(
    "schedule.add_task",
    {
      title: "Compare cabins",
      parent_task_id: { $from: "4.task_id" },
      effort_min: 45,
    },
    ["task_id"]
  );
  execute(
    "schedule.add_task",
    {
      title: "Book the cabin",
      parent_task_id: { $from: "4.task_id" },
      due_at: "2099-06-04T09:00:00.000Z",
      priority: 8,
    },
    ["task_id"]
  );
  const packing = execute<{ task_id: string }>(
    "schedule.add_task",
    { title: "Draft packing list", parent_task_id: { $from: "4.task_id" } },
    ["task_id"]
  );
  execute(
    "schedule.set_task_status",
    { task_id: { $from: "7.task_id" }, status: "completed" },
    ["task_id", "status", "series_id"]
  );

  // THE PROMOTION RULE: a completed parent with an unfinished child.
  execute<{ task_id: string }>(
    "schedule.add_task",
    { title: "Tax return", due_at: "2099-06-02T09:00:00.000Z", priority: 5 },
    ["task_id"]
  );
  execute(
    "schedule.add_task",
    { title: "Find the receipts", parent_task_id: { $from: "9.task_id" } },
    ["task_id"]
  );
  execute(
    "schedule.set_task_status",
    { task_id: { $from: "9.task_id" }, status: "completed" },
    ["task_id", "status", "series_id"]
  );

  // A CANCELLED TASK: `completed_at` is NULL, which is the nullable sort
  // column the logbook orders by.
  execute<{ task_id: string }>(
    "schedule.add_task",
    { title: "Renew the parking permit", due_at: "2099-06-03T09:00:00.000Z" },
    ["task_id"]
  );
  execute(
    "schedule.set_task_status",
    { task_id: { $from: "12.task_id" }, status: "cancelled" },
    ["task_id", "status", "series_id"]
  );

  // AN UNDATED TASK, so "nulls last" is a fact.
  execute(
    "schedule.add_task",
    { title: "Learn to make sourdough", priority: 1 },
    ["task_id"]
  );

  // A REPEATING TASK IN A DST ZONE. 09:00 New York on the day before the
  // spring transition; a reader that spells the zone column wrong answers an
  // hour out for every member outside UTC.
  const watering = execute<{ task_id: string }>(
    "schedule.add_task",
    {
      title: "Water the plants",
      due_at: "2026-03-07T14:00:00.000Z",
      rrule: "FREQ=DAILY",
      priority: 2,
      remind_before_min: 30,
    },
    ["task_id"]
  );
  execute(
    "schedule.organize_task",
    {
      task_id: { $from: "15.task_id" },
      project_id: { $from: "0.project_id" },
      section_id: { $from: "2.section_id" },
      sort_order: 3,
      tz: "America/New_York",
      recurrence_anchor: "scheduled",
    },
    ["task_id"]
  );

  // THE REFUSALS, each one a case a port gets wrong.
  execute("schedule.add_task", { title: "When", due_at: "banana" }, [], "any");
  execute(
    "schedule.add_task",
    {
      title: "Rent",
      due_at: "2099-07-01T09:00:00.000Z",
      rrule: "FREQ=MONTHLY;BYSETPOS=-1",
    },
    [],
    "any"
  );
  execute(
    "schedule.add_task",
    { title: "Rent", rrule: "FREQ=MONTHLY" },
    [],
    "any"
  );
  execute(
    "schedule.organize_task",
    {
      task_id: { $from: "4.task_id" },
      project_id: { $from: "1.project_id" },
      section_id: { $from: "2.section_id" },
      sort_order: 0,
    },
    [],
    "any"
  );
  // A grandchild: one level of nesting only.
  execute(
    "schedule.add_task",
    { title: "Grandchild", parent_task_id: { $from: "5.task_id" } },
    [],
    "any"
  );
  // A TAG on a task, and the label the board draws from it.
  execute(
    "core.tag_item",
    {
      subject_type: "schedule.task",
      subject_id: { $from: "4.task_id" },
      label: "Travel",
    },
    ["tag_id", "concept_id", "notation"]
  );
  // An EDIT, then the trash and a restore.
  execute(
    "schedule.edit_task",
    {
      task_id: { $from: "14.task_id" },
      priority: 4,
      description: "Starter is in the fridge.",
    },
    ["task_id"]
  );
  execute("schedule.delete_task", { task_id: { $from: "12.task_id" } }, [
    "task_id",
    "removed",
  ]);
  execute("schedule.restore_task", { task_id: { $from: "12.task_id" } }, [
    "task_id",
    "restored",
  ]);
  void house;
  void work;
  void kitchen;
  void trip;
  void packing;
  void watering;
}

/**
 * THE EVENT SCRIPT — Agenda's half of the corpus.
 *
 * The cases, and what each one is for:
 *
 * - a **one-off** and a **multi-day span**, so `upcoming`'s reach-back past
 *   `from` is exercised rather than asserted;
 * - a **weekly series with a reminder**, expanded into occurrences;
 * - a **daily series across the March DST boundary in New York**: a gap, a
 *   fold and a wall clock that survives an offset change, all in one series;
 * - an **occurrence skip** and an **occurrence override**, both keyed on the
 *   series-local wall clock (#996 R21, ONT-25);
 * - a **future-scope override**, which reaches every occurrence from its own
 *   key forward;
 * - a **cancelled event**, which `upcoming` never returns and `search` drops
 *   after the hit;
 * - a **trashed event**, so the reversible delete is in the rows;
 * - the refusals: an unsupported rule, a busy conflict, a backwards range, and
 *   an `original_start_local` that is not an occurrence of its series.
 */
export function runEventScript(corpus: Corpus, base: number): void {
  const { execute, calendarId } = corpus;
  const at = (offset: number) => base + offset;
  execute<{ event_id: string }>(
    "schedule.propose_event",
    {
      summary: "Pick up the dry cleaning",
      dtstart: "2099-06-01T17:00:00.000Z",
      dtend: "2099-06-01T17:30:00.000Z",
      start_tz: "Europe/London",
      calendar_id: calendarId,
    },
    ["event_id"]
  );
  execute<{ event_id: string }>(
    "schedule.propose_event",
    {
      summary: "Cabin weekend",
      dtstart: "2099-06-05T16:00:00.000Z",
      dtend: "2099-06-08T10:00:00.000Z",
      start_tz: "Europe/London",
      calendar_id: calendarId,
      description: "Three nights; the drive is the long part.",
    },
    ["event_id"]
  );
  execute<{ event_id: string }>(
    "schedule.propose_event",
    {
      summary: "Morning run",
      description: "Loop around the reservoir.",
      dtstart: "2099-06-02T06:30:00.000Z",
      dtend: "2099-06-02T07:15:00.000Z",
      start_tz: "Europe/London",
      calendar_id: calendarId,
      rrule: "RRULE:FREQ=WEEKLY;BYDAY=MO,TH",
      reminders: [{ minutes_before: 15 }],
    },
    ["event_id"]
  );
  // THE DST SERIES: 09:00 New York, daily, anchored two days before the
  // spring transition.
  execute<{ event_id: string }>(
    "schedule.propose_event",
    {
      summary: "Standup",
      dtstart: "2026-03-06T14:00:00.000Z",
      dtend: "2026-03-06T14:30:00.000Z",
      start_tz: "America/New_York",
      calendar_id: calendarId,
      rrule: "FREQ=DAILY",
      conferencing_uri: "https://example.invalid/standup",
    },
    ["event_id"]
  );
  // An occurrence SKIP and an occurrence OVERRIDE, keyed on the wall clock.
  execute(
    "schedule.edit_event_occurrence",
    {
      event_id: { $from: `${at(3)}.event_id` },
      original_start_local: "2026-03-10T09:00:00",
      scope: "occurrence",
      action: "skip",
    },
    ["event_id", "scope"]
  );
  execute(
    "schedule.edit_event_occurrence",
    {
      event_id: { $from: `${at(3)}.event_id` },
      original_start_local: "2026-03-11T09:00:00",
      scope: "occurrence",
      action: "override",
      summary: "Standup (late)",
      dtstart: "2026-03-11T18:00:00.000Z",
    },
    ["event_id", "scope"]
  );
  // A FUTURE-scope override: every occurrence from its own key forward.
  execute(
    "schedule.edit_event_occurrence",
    {
      event_id: { $from: `${at(3)}.event_id` },
      original_start_local: "2026-03-13T09:00:00",
      scope: "future",
      action: "override",
      dtstart: "2026-03-13T15:00:00.000Z",
    },
    ["event_id", "scope"]
  );
  // THE KEY THAT IS NOT AN OCCURRENCE: the resolved instant offered where the
  // wall clock belongs, which is ONT-25 exactly.
  execute(
    "schedule.edit_event_occurrence",
    {
      event_id: { $from: `${at(3)}.event_id` },
      original_start_local: "2026-03-10T14:00:00.000Z",
      scope: "occurrence",
      action: "skip",
    },
    [],
    "any"
  );
  // A guest, and an RSVP.
  const maya = execute<{ party_id: string }>(
    "core.add_party",
    { display_name: "Maya Ortiz", kind: "person", birth_date: "06-14" },
    ["party_id"]
  );
  execute<{ event_id: string }>(
    "schedule.propose_event",
    {
      summary: "Dinner with Maya",
      dtstart: "2099-06-03T19:00:00.000Z",
      dtend: "2099-06-03T21:00:00.000Z",
      start_tz: "Europe/London",
      calendar_id: calendarId,
      attendee_party_ids: [{ $from: `${at(8)}.party_id` }],
    },
    ["event_id", "attendees"]
  );
  execute(
    "schedule.respond_rsvp",
    {
      event_id: { $from: `${at(9)}.event_id` },
      party_id: { $from: `${at(8)}.party_id` },
      partstat: "accepted",
    },
    ["attendee_id", "partstat"]
  );
  // A CANCELLED event: `upcoming` never returns it, and `search` drops it
  // after the hit rather than before.
  execute<{ event_id: string }>(
    "schedule.propose_event",
    {
      summary: "Dentist — cleaning",
      dtstart: "2099-06-09T15:00:00.000Z",
      dtend: "2099-06-09T16:00:00.000Z",
      start_tz: "Europe/London",
      calendar_id: calendarId,
    },
    ["event_id"]
  );
  execute(
    "schedule.cancel_event",
    { event_id: { $from: `${at(11)}.event_id` } },
    ["event_id", "sequence"]
  );
  // A TRASHED event, left trashed.
  execute<{ event_id: string }>(
    "schedule.propose_event",
    {
      summary: "Book the Tahoe cabin",
      dtstart: "2099-06-04T09:00:00.000Z",
      dtend: "2099-06-04T09:30:00.000Z",
      start_tz: "Europe/London",
      calendar_id: calendarId,
      reminders: [{ minutes_before: 60 }],
    },
    ["event_id"]
  );
  execute(
    "schedule.delete_event",
    { event_id: { $from: `${at(13)}.event_id` } },
    ["event_id", "purge_at"]
  );
  // An EDIT that moves a one-off, and the revision it advances.
  execute(
    "schedule.edit_event",
    {
      event_id: { $from: `${at(0)}.event_id` },
      summary: "Pick up the dry cleaning (Thursday)",
      dtend: "2099-06-01T18:00:00.000Z",
    },
    ["event_id", "sequence"]
  );
  // THE REFUSALS.
  execute(
    "schedule.propose_event",
    {
      summary: "Rent",
      dtstart: "2099-07-31T09:00:00.000Z",
      dtend: "2099-07-31T10:00:00.000Z",
      start_tz: "Europe/London",
      calendar_id: calendarId,
      rrule: "FREQ=MONTHLY;BYSETPOS=-1",
    },
    [],
    "any"
  );
  execute(
    "schedule.propose_event",
    {
      summary: "Overlap",
      dtstart: "2099-06-01T17:15:00.000Z",
      dtend: "2099-06-01T17:45:00.000Z",
      start_tz: "Europe/London",
      calendar_id: calendarId,
    },
    [],
    "any"
  );
  execute(
    "schedule.propose_event",
    {
      summary: "Backwards",
      dtstart: "2099-06-20T10:00:00.000Z",
      dtend: "2099-06-20T09:00:00.000Z",
      start_tz: "Europe/London",
      calendar_id: calendarId,
    },
    [],
    "any"
  );
  void maya;
}
