/*
 * What each bundled app is, expressed as real gateway work (#890 W3).
 *
 * Every recipe below names SHIPPED action ids and SHIPPED entities: `create` is
 * an action the gateway really executes, `queuedWrite` is an action whose
 * shipped pending projection really draws a row
 * (`packages/blueprints/apps/<id>/pending-projection.ts`), `serverEdit` really
 * moves the row's canonical version, and `park` names an action whose vault
 * command really carries `confirm: true`. Nothing here invents an action, an
 * entity, or an outcome — a recipe that drifts from the manifest fails against
 * the real gateway instead of passing against a fake.
 *
 * `blocked` is the honest half. Four apps have no action of their own that
 * routes to a `confirm: true` command, so no arrangement at this tier can make
 * the gateway park their write; saying so in a skip reason is the only truthful
 * option, and `boot-conditions.ts` turns anything that is neither a recipe nor
 * a stated blocker into a failure rather than a silent gap.
 */

import type { ReplicaRow } from "../../../packages/client/src/replica/types.js";
import type { MobileGateway } from "./gateway.js";
import type { MobileSeat } from "./seat.js";

/**
 * One action call, exactly as a seat or the online door takes it. `ReplicaRow`
 * rather than `Record<string, unknown>`: an action input has to survive the
 * durable outbox as JSON, and the session's own `NativeWriteInput` says so.
 */
export interface ActionCall {
  action: string;
  input: ReplicaRow;
}

/** A canonical row this vault really holds, as the replica knows it. */
export interface SeededRow {
  rowId: string;
  values: Record<string, unknown>;
}

/** A state this tier deliberately cannot reach for an app, and why. */
export interface Blocked {
  blocked: string;
}

export function isBlocked(value: unknown): value is Blocked {
  return (
    typeof value === "object" &&
    value !== null &&
    "blocked" in (value as object)
  );
}

export interface RecipeContext {
  gateway: MobileGateway;
  seat: MobileSeat;
  /**
   * Distinguishes two otherwise identical writes. An intent id is derived from
   * the payload, so two byte-identical writes are ONE intent — which would
   * quietly collapse a positive and its negative into the same row.
   */
  label: string;
  /** The canonical row this write addresses, where the app needs one. */
  seed?: SeededRow;
}

export interface AppRecipe {
  appId: string;
  /**
   * The entity these suites read. Chosen to be EMPTY in a fresh vault, which is
   * what makes `dayone` an assertion rather than a hope, and what gives every
   * other state a baseline it can be measured against.
   */
  entity: string;
  /** A canonical create the gateway executes outright. */
  create: (ctx: RecipeContext) => Promise<ActionCall>;
  /**
   * A write whose shipped pending projection stamps a row on `entity`. Takes
   * the seeded row where the app has no queueable create — Locker's create
   * carries a secret and is refused the outbox by design (writes.ts).
   */
  queuedWrite: (ctx: RecipeContext) => Promise<ActionCall>;
  /** True when `queuedWrite` cannot be built without a seeded row. */
  queuedWriteNeedsSeed: boolean;
  /** The phone's edit of a seeded row — the local half of a conflict. */
  editSeeded: (seed: SeededRow) => ActionCall;
  /**
   * A second device's edit of the SAME row, which must really move that row's
   * canonical version. Several apps' obvious edit does not: Tally's
   * `rename-group` renames the group's CIRCLE, leaving `tally.group` untouched,
   * so it would produce no conflict for the phone's precondition to catch.
   */
  serverEdit: (seed: SeededRow) => ActionCall;
  /** An action whose vault command parks, or why this app has none. */
  park: ((seed: SeededRow) => ActionCall) | Blocked;
}

/** Agenda proposes into a calendar that must exist; the vault founds one. */
async function personalCalendarId(seat: MobileSeat): Promise<string> {
  const read = await seat.session.read("agenda", {
    entity: "schedule.calendar",
  });
  const calendarId = read.rows[0]?.values.calendar_id;
  if (typeof calendarId !== "string")
    throw new Error("the auto-founded vault has no schedule.calendar row");
  return calendarId;
}

/**
 * Distinct hours per label. `schedule.propose_event` refuses an overlapping
 * event on the same calendar — a real product rule — so two seeds an hour apart
 * is the difference between an arrangement and a "this time conflicts" failure
 * that has nothing to do with the state under test.
 */
let proposedEvents = 0;

async function proposeEvent(ctx: RecipeContext): Promise<ActionCall> {
  const index = proposedEvents++;
  const day = String(1 + Math.floor(index / 12)).padStart(2, "0");
  const hour = 6 + (index % 12);
  const at = (offset: number): string =>
    `2026-09-${day}T${String(hour + offset).padStart(2, "0")}:00:00.000Z`;
  return {
    action: "propose",
    input: {
      calendar_id: await personalCalendarId(ctx.seat),
      summary: `Event ${ctx.label}`,
      dtstart: at(0),
      dtend: at(1),
    },
  };
}

export const APP_RECIPES: readonly AppRecipe[] = [
  {
    appId: "agenda",
    entity: "core.event",
    create: proposeEvent,
    queuedWrite: proposeEvent,
    queuedWriteNeedsSeed: false,
    editSeeded: (seed) => ({
      action: "edit-event",
      input: { event_id: seed.rowId, summary: "Edited on the phone" },
    }),
    serverEdit: (seed) => ({
      action: "edit-event",
      input: { event_id: seed.rowId, summary: "Edited on the other device" },
    }),
    park: (seed) => ({
      action: "cancel-event",
      input: { event_id: seed.rowId },
    }),
  },
  {
    appId: "docs",
    entity: "core.document",
    create: (ctx) =>
      Promise.resolve({
        action: "upload",
        input: {
          data_uri: "data:text/plain;base64,c2VlZGVk",
          title: `Doc ${ctx.label}`,
        },
      }),
    queuedWrite: (ctx) =>
      Promise.resolve({
        action: "upload",
        input: {
          data_uri: "data:text/plain;base64,cXVldWVk",
          title: `Queued doc ${ctx.label}`,
        },
      }),
    queuedWriteNeedsSeed: false,
    editSeeded: (seed) => ({
      action: "rename",
      input: { document_id: seed.rowId, title: "Renamed on the phone" },
    }),
    serverEdit: (seed) => ({
      action: "rename",
      input: { document_id: seed.rowId, title: "Renamed on the other device" },
    }),
    park: {
      blocked:
        "no Docs action routes to a `confirm: true` vault command — the core.*_document family carries none, so there is no real gateway park to arrange at this tier",
    },
  },
  {
    appId: "locker",
    entity: "locker.item",
    // Through the ONLINE-ONLY door on purpose: `add-item` carries a secret and
    // `packages/blueprints/apps/locker/writes.ts` forbids it the durable outbox.
    create: (ctx) =>
      Promise.resolve({
        action: "add-item",
        input: { type: "note", title: `Secret ${ctx.label}` },
      }),
    queuedWrite: (ctx) =>
      Promise.resolve({
        action: "star-item",
        input: { item_id: requireSeed(ctx).rowId },
      }),
    queuedWriteNeedsSeed: true,
    editSeeded: (seed) => ({
      action: "star-item",
      input: { item_id: seed.rowId },
    }),
    serverEdit: (seed) => ({
      action: "archive-item",
      input: { item_id: seed.rowId },
    }),
    park: (seed) => ({
      action: "purge-item",
      input: { item_id: seed.rowId },
    }),
  },
  {
    appId: "notes",
    entity: "knowledge.note",
    create: (ctx) =>
      Promise.resolve({
        action: "create-note",
        input: { title: `Note ${ctx.label}`, body_text: `body ${ctx.label}` },
      }),
    queuedWrite: (ctx) =>
      Promise.resolve({
        action: "create-note",
        input: {
          title: `Queued note ${ctx.label}`,
          body_text: `queued body ${ctx.label}`,
        },
      }),
    queuedWriteNeedsSeed: false,
    editSeeded: (seed) => ({
      action: "edit-note",
      input: {
        note_id: seed.rowId,
        title: "Edited on the phone",
        body_text: "phone body",
      },
    }),
    serverEdit: (seed) => ({
      action: "edit-note",
      input: {
        note_id: seed.rowId,
        title: "Edited on the other device",
        body_text: "other body",
      },
    }),
    park: {
      blocked:
        "no Notes action routes to a `confirm: true` vault command — the knowledge.* family carries none, so there is no real gateway park to arrange at this tier",
    },
  },
  {
    appId: "people",
    entity: "people.profile",
    create: (ctx) =>
      Promise.resolve({
        action: "add-person",
        input: { display_name: `Person ${ctx.label}`, cadence_days: 30 },
      }),
    queuedWrite: (ctx) =>
      Promise.resolve({
        action: "add-person",
        input: { display_name: `Queued person ${ctx.label}`, cadence_days: 14 },
      }),
    queuedWriteNeedsSeed: false,
    // People addresses the person spine by `party_id`, so its edits — and the
    // conflict that rides them — land on core.party rather than on the profile.
    editSeeded: (seed) => ({
      action: "edit-person",
      input: {
        party_id: String(seed.values.party_id),
        display_name: "Edited on the phone",
      },
    }),
    serverEdit: (seed) => ({
      action: "edit-person",
      input: {
        party_id: String(seed.values.party_id),
        display_name: "Edited on the other device",
      },
    }),
    park: (seed) => ({
      action: "merge-people",
      input: {
        source_party_id: String(seed.values.party_id),
        target_party_id: String(seed.values.party_id),
      },
    }),
  },
  {
    appId: "photos",
    entity: "core.collection",
    create: (ctx) =>
      Promise.resolve({
        action: "create-album",
        input: { title: `Album ${ctx.label}` },
      }),
    queuedWrite: (ctx) =>
      Promise.resolve({
        action: "create-album",
        input: { title: `Queued album ${ctx.label}` },
      }),
    queuedWriteNeedsSeed: false,
    editSeeded: (seed) => ({
      action: "rename-album",
      input: { album_id: seed.rowId, title: "Renamed on the phone" },
    }),
    serverEdit: (seed) => ({
      action: "rename-album",
      input: { album_id: seed.rowId, title: "Renamed on the other device" },
    }),
    park: {
      blocked:
        "no Photos action routes to a `confirm: true` vault command — media.forget_person is the only parking media command and no bundled Photos action calls it",
    },
  },
  {
    appId: "tally",
    entity: "tally.group",
    create: (ctx) =>
      Promise.resolve({
        action: "create-group",
        input: { name: `Group ${ctx.label}`, icon: "home", member_ids: [] },
      }),
    queuedWrite: (ctx) =>
      Promise.resolve({
        action: "create-group",
        input: {
          name: `Queued group ${ctx.label}`,
          icon: "home",
          member_ids: [],
        },
      }),
    queuedWriteNeedsSeed: false,
    editSeeded: (seed) => ({
      action: "set-group-simplification",
      input: { group_id: seed.rowId, simplify: true },
    }),
    serverEdit: (seed) => ({
      action: "archive-group",
      input: { group_id: seed.rowId, archived: true },
    }),
    park: (seed) => ({
      action: "nudge",
      input: {
        group_id: seed.rowId,
        party_id: String(seed.values.circle_id),
        as_of_minor: 500,
      },
    }),
  },
  {
    appId: "tasks",
    entity: "schedule.task",
    create: (ctx) =>
      Promise.resolve({ action: "add", input: { title: `Task ${ctx.label}` } }),
    queuedWrite: (ctx) =>
      Promise.resolve({
        action: "add",
        input: { title: `Queued task ${ctx.label}` },
      }),
    queuedWriteNeedsSeed: false,
    editSeeded: (seed) => ({
      action: "edit",
      input: { task_id: seed.rowId, title: "Edited on the phone" },
    }),
    serverEdit: (seed) => ({
      action: "edit",
      input: { task_id: seed.rowId, title: "Edited on the other device" },
    }),
    park: {
      blocked:
        "no Tasks action routes to a `confirm: true` vault command — schedule's parking commands are all event-shaped, and none of the schedule.*_task family carries one",
    },
  },
];

function requireSeed(ctx: RecipeContext): SeededRow {
  if (!ctx.seed)
    throw new Error(`${ctx.label}: this recipe needs a seeded row`);
  return ctx.seed;
}

export function recipeFor(appId: string): AppRecipe | undefined {
  return APP_RECIPES.find((recipe) => recipe.appId === appId);
}
