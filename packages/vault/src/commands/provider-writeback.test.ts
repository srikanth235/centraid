import { beforeEach, describe, expect, test } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import type { Gateway } from "../gateway/gateway.js";
import { createGateway } from "../gateway/gateway.js";
import type { Credential, InvokeOutcome } from "../gateway/types.js";
import { registerPeopleCommands } from "./people.js";
import { registerScheduleCommands } from "./schedule.js";
import { registerSyncCommands } from "./sync.js";

let db: VaultDb;
let gateway: Gateway;
let owner: Credential;
let boot: BootstrapResult;

function outputOf(outcome: InvokeOutcome): Record<string, unknown> {
  expect(outcome.status).toBe("executed");
  if (outcome.status !== "executed") throw new Error(outcome.status);
  return outcome.output as Record<string, unknown>;
}

describe("provider write-back", () => {
  beforeEach(() => {
    db = openVaultDb();
    boot = bootstrapVault(db, { ownerName: "Priya" });
    gateway = createGateway(db);
    registerSyncCommands(gateway);
    registerScheduleCommands(gateway);
    registerPeopleCommands(gateway);
    owner = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
  });

  function invoke(command: string, input: Record<string, unknown>) {
    return gateway.invoke(owner, {
      command,
      input,
    });
  }

  function stageAndPublish(
    kind: "pull.gcal" | "pull.gcontacts",
    row: Record<string, unknown>
  ): { connectionId: string; entityId: string } {
    const staged = outputOf(
      invoke("sync.stage_rows", {
        kind,
        label: "personal",
        rows: [row],
      })
    );
    const batchId = String(staged["batch_id"]);
    gateway.publishImport(owner, batchId);
    const mapped = db.vault
      .prepare(
        `SELECT connection_id, target_id FROM sync_external_entity
          WHERE external_id = ?`
      )
      .get(String(row["external_id"])) as {
      connection_id: string;
      target_id: string;
    };
    return {
      connectionId: mapped.connection_id,
      entityId: mapped.target_id,
    };
  }

  test("local Google event edit queues an approved version-checked PATCH with field provenance", () => {
    const imported = stageAndPublish("pull.gcal", {
      entity_type: "core.event",
      external_id: "gcal:event-1",
      payload: {
        uid: "ical-event-1",
        summary: "Original",
        description: null,
        dtstart: "2026-08-01T09:00:00Z",
        dtend: "2026-08-01T10:00:00Z",
        startTz: "Asia/Kolkata",
        rrule: null,
        status: "confirmed",
        providerVersion: '"etag-1"',
        providerUpdatedAt: "2026-07-29T08:00:00Z",
      },
    });

    outputOf(
      invoke("schedule.edit_event", {
        event_id: imported.entityId,
        summary: "Local title",
        dtstart: "2026-08-01T09:30:00Z",
        dtend: "2026-08-01T10:30:00Z",
      })
    );
    const row = db.vault
      .prepare(
        `SELECT status, verb, artifact_json, request_json, target_type, target_id
           FROM outbox_item WHERE connection_id = ?`
      )
      .get(imported.connectionId) as {
      status: string;
      verb: string;
      artifact_json: string;
      request_json: string;
      target_type: string;
      target_id: string;
    };
    expect(row).toMatchObject({
      status: "approved",
      verb: "gcal.update_event",
      target_type: "core.event",
      target_id: imported.entityId,
    });
    const request = JSON.parse(row.request_json) as {
      method: string;
      url: string;
      headers: Record<string, string>;
      body: string;
    };
    expect(request).toMatchObject({
      method: "PATCH",
      url: "https://www.googleapis.com/calendar/v3/calendars/primary/events/event-1",
      headers: {
        authorization: "Bearer {{connection:access_token}}",
        "if-match": '"etag-1"',
      },
    });
    expect(JSON.parse(request.body)).toMatchObject({
      summary: "Local title",
      start: { dateTime: "2026-08-01T09:30:00Z" },
    });
    const artifact = JSON.parse(row.artifact_json) as {
      provenance: Record<string, { source: string; providerVersion: string }>;
    };
    expect(artifact.provenance["summary"]).toMatchObject({
      source: "local",
      providerVersion: '"etag-1"',
    });
    expect(artifact.provenance["status"]?.source).toBe("google");
  });

  test("provider conflicts never overwrite local state and remain reviewable", () => {
    const imported = stageAndPublish("pull.gcal", {
      entity_type: "core.event",
      external_id: "gcal:event-conflict",
      payload: {
        uid: "ical-conflict",
        summary: "Original",
        description: null,
        dtstart: "2026-08-01T09:00:00Z",
        dtend: null,
        startTz: null,
        rrule: null,
        status: "confirmed",
        providerVersion: '"etag-1"',
      },
    });
    outputOf(
      invoke("schedule.edit_event", {
        event_id: imported.entityId,
        summary: "Local wins",
      })
    );
    const staged = outputOf(
      invoke("sync.stage_rows", {
        connection_id: imported.connectionId,
        rows: [
          {
            entity_type: "core.event",
            external_id: "gcal:event-conflict",
            payload: {
              uid: "ical-conflict",
              summary: "Provider changed too",
              description: null,
              dtstart: "2026-08-01T09:00:00Z",
              dtend: null,
              startTz: null,
              rrule: null,
              status: "confirmed",
              providerVersion: '"etag-2"',
            },
          },
        ],
      })
    );
    expect(staged["staged"]).toMatchObject({ "merge-candidate": 1 });
    gateway.publishImport(owner, String(staged["batch_id"]));
    expect(
      (
        db.vault
          .prepare("SELECT summary FROM core_event WHERE event_id = ?")
          .get(imported.entityId) as { summary: string }
      ).summary
    ).toBe("Local wins");

    const repeated = outputOf(
      invoke("sync.stage_rows", {
        connection_id: imported.connectionId,
        rows: [
          {
            entity_type: "core.event",
            external_id: "gcal:event-conflict",
            payload: {
              uid: "ical-conflict",
              summary: "Provider changed too",
              description: null,
              dtstart: "2026-08-01T09:00:00Z",
              dtend: null,
              startTz: null,
              rrule: null,
              status: "confirmed",
              providerVersion: '"etag-2"',
            },
          },
        ],
      })
    );
    expect(repeated["staged"]).toMatchObject({ "merge-candidate": 1 });
  });

  test("contact write-back and approved queue survive revoke then reconnect", () => {
    const imported = stageAndPublish("pull.gcontacts", {
      entity_type: "core.party",
      external_id: "gcontacts:people/contact-1",
      payload: {
        fn: "Asha Rao",
        sortName: "Rao, Asha",
        bday: "--04-21",
        identifiers: [
          { scheme: "email", value: "asha@example.test", label: "home" },
        ],
        providerVersion: "contact-etag-1",
      },
    });
    outputOf(
      invoke("sync.begin_run", {
        connection_id: imported.connectionId,
        principal: "owner@example.test",
      })
    );
    outputOf(
      invoke("sync.set_connection_status", {
        connection_id: imported.connectionId,
        status: "needs-auth",
        note: "access revoked upstream",
      })
    );
    outputOf(
      invoke("people.edit_person", {
        party_id: imported.entityId,
        display_name: "Asha Rao-Singh",
      })
    );
    const queued = db.vault
      .prepare(
        "SELECT status, request_json FROM outbox_item WHERE connection_id = ?"
      )
      .get(imported.connectionId) as {
      status: string;
      request_json: string;
    };
    expect(queued.status).toBe("approved");
    expect(JSON.parse(queued.request_json)).toMatchObject({
      method: "PATCH",
      url: "https://people.googleapis.com/v1/people/contact-1:updateContact?updatePersonFields=names,emailAddresses,phoneNumbers,birthdays",
    });

    const reconnected = outputOf(
      invoke("sync.begin_run", {
        connection_id: imported.connectionId,
        principal: "owner@example.test",
      })
    );
    expect(reconnected["refused"]).toBeUndefined();
    expect(
      (
        db.vault
          .prepare("SELECT status FROM sync_connection WHERE connection_id = ?")
          .get(imported.connectionId) as { status: string }
      ).status
    ).toBe("active");
    expect(
      (
        db.vault
          .prepare("SELECT status FROM outbox_item WHERE connection_id = ?")
          .get(imported.connectionId) as { status: string }
      ).status
    ).toBe("approved");
  });
});
