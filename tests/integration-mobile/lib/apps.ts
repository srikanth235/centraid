import type { ReplicaRow } from "../../../packages/client/src/replica/types.js";
import type { MobileGateway } from "./gateway.js";
import type { MobileSeat } from "./seat.js";

export interface ActionCall {
  action: string;
  input: ReplicaRow;
}

export interface SeededRow {
  rowId: string;
  values: Record<string, unknown>;
}

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
  label: string;
  seed?: SeededRow;
}

export interface AppRecipe {
  appId: string;
  entity: string;
  create: (ctx: RecipeContext) => Promise<ActionCall>;
  queuedWrite: (ctx: RecipeContext) => Promise<ActionCall>;
  queuedWriteNeedsSeed: boolean;
  editSeeded: (seed: SeededRow) => ActionCall;
  serverEdit: (seed: SeededRow) => ActionCall;
  park: ((seed: SeededRow) => ActionCall) | Blocked;
}

async function personalCalendarId(seat: MobileSeat): Promise<string> {
  const read = await seat.session.read("agenda", {
    entity: "schedule.calendar",
  });
  const calendarId = read.rows[0]?.values.calendar_id;
  if (typeof calendarId !== "string")
    throw new Error("the auto-founded vault has no schedule.calendar row");
  return calendarId;
}

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
