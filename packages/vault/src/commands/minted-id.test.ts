/*
 * The origin's half of a seat-minted row id, for every app that mints one
 * (#922 G2). Tasks' own case lives with its command; this file holds the other
 * seven apps as ONE table, because the property is the same for all of them
 * and stating it once per app is what keeps a new creating command from
 * quietly declaring the schema property without the precondition.
 *
 * Two halves, both asserted per command: an id the seat minted is the id the
 * row is created under, and the SAME id a second time is refused rather than
 * merged into the row someone is already looking at.
 */
import { beforeEach, describe, expect, test } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { createGateway } from "../gateway/gateway.js";
import type { Gateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import { uuidv7 } from "../ids.js";
import { registerDocumentCommands } from "./documents.js";
import { registerKnowledgeCommands } from "./knowledge.js";
import { registerMediaCommands } from "./media.js";
import { registerPeopleCommands } from "./people.js";
import { registerScheduleCommands } from "./schedule.js";
import { registerTallyCommands } from "./tally.js";

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;
/** Agenda's event lands on a calendar, so one exists before the case runs. */
let calendarId: string;

/** A UUIDv8 in the shape `stablePendingRowId` mints, one per case. */
function mintedId(nth: number): string {
  return `1f2e3d4c-0000-8000-8000-${String(nth).padStart(12, "0")}`;
}

interface MintedCase {
  app: string;
  command: string;
  property: string;
  input: (id: string) => Record<string, unknown>;
}

const CASES: MintedCase[] = [
  {
    app: "agenda",
    command: "schedule.propose_event",
    property: "event_id",
    input: (event_id) => ({
      event_id,
      summary: "Site visit",
      dtstart: "2026-09-10T09:00:00.000Z",
      dtend: "2026-09-10T10:00:00.000Z",
      calendar_id: calendarId,
    }),
  },
  {
    app: "docs",
    command: "core.create_folder",
    property: "folder_id",
    input: (folder_id) => ({
      folder_id,
      name: `Papers ${folder_id.slice(-4)}`,
    }),
  },
  {
    app: "notes",
    command: "knowledge.create_notebook",
    property: "notebook_id",
    input: (notebook_id) => ({
      notebook_id,
      name: `Lease ${notebook_id.slice(-4)}`,
    }),
  },
  {
    app: "notes",
    command: "knowledge.create_note",
    property: "note_id",
    input: (note_id) => ({
      note_id,
      title: `Deposit ${note_id.slice(-4)}`,
      body_text: "The deposit clause moved to §4.",
    }),
  },
  {
    app: "people",
    command: "people.add_person",
    property: "party_id",
    input: (party_id) => ({
      party_id,
      display_name: `Ravi ${party_id.slice(-4)}`,
      cadence_days: 30,
    }),
  },
  {
    app: "people",
    command: "people.create_list",
    property: "list_id",
    input: (list_id) => ({ list_id, name: `Work ${list_id.slice(-4)}` }),
  },
  {
    app: "photos",
    command: "media.create_album",
    property: "album_id",
    input: (album_id) => ({ album_id, title: `Beach ${album_id.slice(-4)}` }),
  },
  {
    app: "tally",
    command: "tally.create_group",
    property: "group_id",
    input: (group_id) => ({
      group_id,
      name: `Flat ${group_id.slice(-4)}`,
      icon: "home",
      member_ids: [],
    }),
  },
];

describe("a row id minted at the seat", () => {
  beforeEach(() => {
    db = openVaultDb();
    boot = bootstrapVault(db, { ownerName: "Priya" });
    gw = createGateway(db);
    registerDocumentCommands(gw);
    registerKnowledgeCommands(gw);
    registerMediaCommands(gw);
    registerPeopleCommands(gw);
    registerScheduleCommands(gw);
    registerTallyCommands(gw);
    owner = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
    calendarId = uuidv7();
    db.vault
      .prepare(
        `INSERT INTO schedule_calendar (calendar_id, owner_party_id, name, default_tz, visibility)
         VALUES (?, ?, 'Personal', 'Asia/Kolkata', 'private')`
      )
      .run(calendarId, boot.ownerPartyId);
  });

  test.each(CASES)(
    "$app: $command creates the row under the id the seat showed",
    ({ command, property, input }) => {
      const id = mintedId(1);
      const first = gw.invoke(owner, {
        command,
        input: input(id),
      });
      expect(first.status).toBe("executed");
      expect(
        (first as { output: Record<string, string> }).output[property]
      ).toBe(id);
    }
  );

  test.each(CASES)(
    "$app: $command refuses an id it already holds rather than merging",
    ({ command, property, input }) => {
      const id = mintedId(2);
      expect(
        gw.invoke(owner, {
          command,
          input: input(id),
        }).status
      ).toBe("executed");
      const again = gw.invoke(owner, {
        command,
        input: { ...input(id), [property]: id },
      });
      expect(again.status).not.toBe("executed");
    }
  );

  test.each(CASES)(
    "$app: $command still mints its own id when the seat sent none",
    ({ command, property, input }) => {
      const { [property]: _minted, ...rest } = input(mintedId(3));
      const outcome = gw.invoke(owner, {
        command,
        input: rest,
      });
      expect(outcome.status).toBe("executed");
      expect(
        (outcome as { output: Record<string, string> }).output[property]
      ).toMatch(/^[\da-f-]{36}$/u);
    }
  );
});
