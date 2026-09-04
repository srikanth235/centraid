// Grant-plane seam into invoke (#825, G-edit, #929). `routeShareGrantEdit`
// answers about a CONTAINER, not a writer; the seam is actor-aware so the
// owner's own grant never refuses the owner's write. Since #929 the answer is
// the whole of the authorization — there is no second rail row — so a routed
// write with an `edit` answer lands and a `view` answer refuses BY NAME.
import { afterEach, describe, expect, test } from "vitest";

import { createGrant, enrollAgent, enrollDevice } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { registerDocumentCommands } from "../commands/documents.js";
import { registerTallyCommands } from "../commands/tally.js";
import type { VaultDb } from "../db.js";
import { createShareGrant } from "../grant/grant-store.js";
import { nowIso } from "../ids.js";
import { closeOpenVaults, household } from "../share/placement-fixture.js";
import { createGateway } from "./gateway.js";
import type { Gateway } from "./gateway.js";
import type { Credential } from "./types.js";

const PURPOSE = "dpv:ServiceProvision";

function ownerSeat(register: (gateway: Gateway) => void) {
  const { origin, originBoot } = household();
  const gateway = createGateway(origin);
  register(gateway);
  const owner: Credential = {
    kind: "device",
    deviceId: originBoot.deviceId,
    deviceKey: originBoot.deviceKey,
  };
  const invoke = (command: string, input: Record<string, unknown>) => {
    const outcome = gateway.invoke(owner, { command, input });
    if (outcome.status !== "executed")
      throw new Error(`command failed: ${JSON.stringify(outcome)}`);
    return outcome.output as Record<string, string>;
  };
  return { origin, originBoot, gateway, owner, invoke };
}

function docsSeat() {
  const seat = ownerSeat(registerDocumentCommands);
  const folderId = seat.invoke("core.create_folder", {
    name: "Trip",
  }).folder_id!;
  const documentId = seat.invoke("core.add_document", {
    folder_id: folderId,
    title: "Train ticket",
    data_uri: "data:text/plain,train",
  }).document_id!;
  return { ...seat, folderId, documentId };
}

/** An EDIT subject with a declared write surface. */
function tallySeat() {
  const seat = ownerSeat(registerTallyCommands);
  return {
    ...seat,
    createGroup: (memberPartyIds: string[] = []) =>
      seat.invoke("tally.create_group", {
        name: "Trip",
        icon: "🧳",
        member_ids: memberPartyIds,
      }).group_id!,
  };
}

/** One live grant over a subject, always issued by the seat's own owner. */
function grantTo(
  seat: { origin: VaultDb; originBoot: BootstrapResult },
  audience: { partyId: string },
  subject: { type: "docs.folder" | "tally.group"; id: string },
  capability: "view" | "edit",
  now = nowIso()
): void {
  createShareGrant(seat.origin.vault, {
    audience: { kind: "party", id: audience.partyId },
    subjectType: subject.type,
    subjectId: subject.id,
    capability,
    grantedAt: now,
    grantedBy: seat.originBoot.ownerPartyId,
  });
}

/** Party credential that is not the vault owner (enrolled agent). */
function audienceAgent(
  seat: { origin: VaultDb; originBoot: BootstrapResult },
  name = "ravi-seat",
  schema = "core"
) {
  const agent = enrollAgent(seat.origin, { name, modelRef: "model-x" });
  const device = enrollDevice(
    seat.origin,
    seat.originBoot.ownerPartyId,
    "host"
  );
  createGrant(seat.origin, {
    granteePartyId: agent.partyId,
    purposeConceptId: seat.originBoot.concepts[PURPOSE] as string,
    grantedByPartyId: seat.originBoot.ownerPartyId,
    scopes: [{ schema, verbs: "read+act" }],
  });
  const credential: Credential = {
    kind: "agent",
    agentId: agent.agentId,
    deviceId: device.deviceId,
    deviceKey: device.deviceKey,
  };
  return { partyId: agent.partyId, credential };
}

describe("where an audience's edit is actually enforced", () => {
  afterEach(closeOpenVaults);

  test("an origin-side audience's edit lands, and a view answer refuses by name", () => {
    const seat = tallySeat();
    const audience = audienceAgent(seat, "ravi-seat", "tally");
    const groupId = seat.createGroup([audience.partyId]);
    grantTo(seat, audience, { type: "tally.group", id: groupId }, "edit");
    expect(
      seat.gateway.invoke(audience.credential, {
        command: "tally.rename_group",
        input: { group_id: groupId, name: "Museum trip" },
      })
    ).toMatchObject({ status: "executed" });

    const viewer = audienceAgent(seat, "asha-seat", "tally");
    const viewedGroup = seat.createGroup([viewer.partyId]);
    grantTo(seat, viewer, { type: "tally.group", id: viewedGroup }, "view");
    expect(
      seat.gateway.invoke(viewer.credential, {
        command: "tally.rename_group",
        input: { group_id: viewedGroup, name: "Museum trip" },
      })
    ).toMatchObject({
      status: "denied",
      reason: `tally.rename_group writes into tally.group ${viewedGroup}, which is shared for view only`,
    });
  });
});

describe("the grant plane's seam into invoke", () => {
  afterEach(closeOpenVaults);

  test("the owner's own edit inside a folder they shared for view is not refused", () => {
    const seat = docsSeat();
    const audience = audienceAgent(seat);
    grantTo(seat, audience, { type: "docs.folder", id: seat.folderId }, "view");

    // Router refuses the container; the seam asks who is writing first.
    const outcome = seat.gateway.invoke(seat.owner, {
      command: "core.edit_document",
      input: { document_id: seat.documentId, body_text: "Amended" },
    });
    expect(outcome.status).toBe("executed");
  });

  test("a write on behalf of a named audience is refused by the view-only grant", () => {
    const seat = docsSeat();
    const audience = audienceAgent(seat);
    grantTo(seat, audience, { type: "docs.folder", id: seat.folderId }, "view");

    const outcome = seat.gateway.invoke(audience.credential, {
      command: "core.edit_document",
      input: { document_id: seat.documentId, body_text: "Amended" },
    });
    expect(outcome).toMatchObject({
      status: "denied",
      // Engine sentence, not a seam paraphrase.
      reason: `core.edit_document writes into docs.folder ${seat.folderId}, which is shared for view only`,
    });
  });

  test("group co-contribution reaches the seam: offered on edit, refused on view", () => {
    const seat = tallySeat();
    const editor = audienceAgent(seat, "ravi-seat", "tally");
    const viewer = audienceAgent(seat, "asha-seat", "tally");
    const groupId = seat.createGroup([editor.partyId]);
    const now = nowIso();
    const subject = { type: "tally.group", id: groupId } as const;
    grantTo(seat, editor, subject, "edit", now);
    grantTo(seat, viewer, subject, "view", now);
    const expense = (description: string) => ({
      command: "tally.add_expense",
      input: {
        group_id: groupId,
        description,
        amount_minor: 900,
        paid_by: seat.originBoot.ownerPartyId,
        category: "food",
        splits: [{ party_id: seat.originBoot.ownerPartyId, share_minor: 900 }],
      },
    });

    // The seam sees an introducing command, not only a write inside.
    expect(
      seat.gateway.invoke(viewer.credential, expense("Cab"))
    ).toMatchObject({
      status: "denied",
      reason: `tally.add_expense writes into tally.group ${groupId}, which is shared for view only`,
    });
    // An edit-bearing audience is refused nothing and the add lands here, in
    // the container's own vault. The refusal every container WITHOUT an edit
    // strategy still answers is unit-pinned on `shareGrantEditRefusal`
    // (grant/fulfillment-edit.test.ts).
    expect(
      seat.gateway.invoke(editor.credential, expense("Hotel")).status
    ).toBe("executed");
    expect(seat.gateway.invoke(seat.owner, expense("Museum")).status).toBe(
      "executed"
    );
    expect(
      seat.origin.vault
        .prepare("SELECT count(*) AS n FROM tally_expense WHERE group_id = ?")
        .get(groupId)
    ).toMatchObject({ n: 2 });
  });

  test("a party no grant names is left to the layer that was already deciding", () => {
    const seat = docsSeat();
    const stranger = audienceAgent(seat);
    const other = audienceAgent(seat, "asha-seat");
    grantTo(seat, other, { type: "docs.folder", id: seat.folderId }, "view");

    const outcome = seat.gateway.invoke(stranger.credential, {
      command: "core.edit_document",
      input: { document_id: seat.documentId, body_text: "Amended" },
    });
    expect(outcome.status).not.toBe("denied");
  });

  test("a view-only audience is refused even where another audience holds edit", () => {
    const seat = tallySeat();
    const editor = audienceAgent(seat, "ravi-seat", "tally");
    const viewer = audienceAgent(seat, "asha-seat", "tally");
    const stranger = audienceAgent(seat, "dev-seat", "tally");
    const groupId = seat.createGroup([editor.partyId]);
    const now = nowIso();
    for (const [audience, capability] of [
      [editor, "edit"],
      [viewer, "view"],
    ] as const)
      grantTo(
        seat,
        audience,
        { type: "tally.group", id: groupId },
        capability,
        now
      );
    const rename = {
      command: "tally.rename_group",
      input: { group_id: groupId, name: "Museum trip" },
    };
    const renamed = () =>
      (
        seat.origin.vault
          .prepare(
            `SELECT c.name FROM tally_group g
               JOIN social_circle c ON c.circle_id = g.circle_id
              WHERE g.group_id = ?`
          )
          .get(groupId) as { name: string }
      ).name;

    // Container-level edit grant is Ravi's; Asha is still view-only.
    expect(seat.gateway.invoke(viewer.credential, rename)).toMatchObject({
      status: "denied",
      reason: `tally.rename_group writes into tally.group ${groupId}, which is shared for view only`,
    });
    // The seam refuses before the write, so nothing landed for the viewer.
    expect(renamed()).toBe("Trip");

    expect(seat.gateway.invoke(editor.credential, rename).status).toBe(
      "executed"
    );
    expect(renamed()).toBe("Museum trip");
    expect(seat.gateway.invoke(seat.owner, rename).status).toBe("executed");
    expect(seat.gateway.invoke(stranger.credential, rename).status).not.toBe(
      "denied"
    );
  });
});
