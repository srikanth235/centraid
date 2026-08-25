// Grant-plane seam into invoke (#825, G-edit). `routeShareGrantEdit` answers
// about a container, not a writer; the seam is actor-aware so the owner's own
// grant never refuses the owner's write. Grants never project — own-seat
// writes ride the commons rail.
import { afterEach, describe, expect, test } from "vitest";

import { createGrant, enrollAgent, enrollDevice } from "../bootstrap.js";
import { registerDocumentCommands } from "../commands/documents.js";
import { createShareGrant } from "../grant/grant-store.js";
import { nowIso } from "../ids.js";
import { folderCommons } from "../share/commons-replay.test-fixtures.js";
import { createCommonsGrant } from "../share/commons.js";
import { closeOpenVaults, household } from "../share/placement-fixture.js";
import { createGateway } from "./gateway.js";
import type { Credential } from "./types.js";

const PURPOSE = "dpv:ServiceProvision";

function docsSeat() {
  const { origin, originBoot } = household();
  const gateway = createGateway(origin);
  registerDocumentCommands(gateway);
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
  const folderId = invoke("core.create_folder", { name: "Trip" }).folder_id!;
  const documentId = invoke("core.add_document", {
    folder_id: folderId,
    title: "Train ticket",
    data_uri: "data:text/plain,train",
  }).document_id!;
  return { origin, originBoot, gateway, owner, invoke, folderId, documentId };
}

/** Party credential that is not the vault owner (enrolled agent). */
function audienceAgent(seat: ReturnType<typeof docsSeat>, name = "ravi-seat") {
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
    scopes: [{ schema: "core", verbs: "read+act" }],
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

  test("a member's own-seat edit rides the commons rail; grants stay origin-only", () => {
    const fixture = folderCommons(1);
    const documentId = fixture.documents[0] as string;
    const memberPartyId = fixture.home.audienceBoot.ownerPartyId;
    createShareGrant(fixture.home.origin.vault, {
      audience: { kind: "party", id: memberPartyId },
      subjectType: "docs.folder",
      subjectId: fixture.folderId,
      capability: "edit",
      grantedAt: nowIso(),
      grantedBy: fixture.home.originBoot.ownerPartyId,
    });

    // share_grant rows never project; own-seat writes have no grant plane.
    expect(
      fixture.home.audience.vault
        .prepare("SELECT COUNT(*) AS n FROM share_grant")
        .get()
    ).toMatchObject({ n: 0 });

    const edit = {
      document_id: documentId,
      body_text: "Museum tickets attached",
      title: "Museum tickets",
    };
    const queued = fixture.member.gateway.invoke(fixture.member.credential, {
      command: "core.edit_document",
      input: edit,
      intentId: "member-edit",
      intentDeviceId: fixture.home.audienceBoot.deviceId,
    });
    expect(queued).toMatchObject({
      status: "denied",
      reason: "waiting for Priya's device",
    });
    expect(
      fixture.home.audience.vault
        .prepare("SELECT status FROM share_commons_intent WHERE intent_id = ?")
        .get("member-edit")
    ).toMatchObject({ status: "queued" });
    expect(fixture.documentTitle(documentId)).toBe("Booking 0");

    fixture.write("core.edit_document", edit);
    expect(fixture.documentTitle(documentId)).toBe("Museum tickets");
    expect(
      fixture.home.origin.vault
        .prepare(
          `SELECT COUNT(*) AS n FROM share_commons_op
            WHERE grant_id = ? AND command = 'core.edit_document'`
        )
        .get(fixture.grantId)
    ).toMatchObject({ n: 1 });
  });

  test("an origin-side audience with an edit grant but no rail is refused", () => {
    const seat = docsSeat();
    const audience = audienceAgent(seat);
    createShareGrant(seat.origin.vault, {
      audience: { kind: "party", id: audience.partyId },
      subjectType: "docs.folder",
      subjectId: seat.folderId,
      capability: "edit",
      grantedAt: nowIso(),
      grantedBy: seat.originBoot.ownerPartyId,
    });

    // Nowhere to land is refused, not applied privately (#750).
    expect(
      seat.gateway.invoke(audience.credential, {
        command: "core.edit_document",
        input: { document_id: seat.documentId, body_text: "Amended" },
      })
    ).toMatchObject({
      status: "denied",
      reason: `docs.folder ${seat.folderId} has no commons rail to route core.edit_document to`,
    });
  });
});

describe("the grant plane's seam into invoke", () => {
  afterEach(closeOpenVaults);

  test("the owner's own edit inside a folder they shared for view is not refused", () => {
    const seat = docsSeat();
    const audience = audienceAgent(seat);
    createShareGrant(seat.origin.vault, {
      audience: { kind: "party", id: audience.partyId },
      subjectType: "docs.folder",
      subjectId: seat.folderId,
      capability: "view",
      grantedAt: nowIso(),
      grantedBy: seat.originBoot.ownerPartyId,
    });

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
    createShareGrant(seat.origin.vault, {
      audience: { kind: "party", id: audience.partyId },
      subjectType: "docs.folder",
      subjectId: seat.folderId,
      capability: "view",
      grantedAt: nowIso(),
      grantedBy: seat.originBoot.ownerPartyId,
    });

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

  test("folder co-contribution is refused for the audience and allowed for the owner", () => {
    const seat = docsSeat();
    const audience = audienceAgent(seat);
    createShareGrant(seat.origin.vault, {
      audience: { kind: "party", id: audience.partyId },
      subjectType: "docs.folder",
      subjectId: seat.folderId,
      capability: "edit",
      grantedAt: nowIso(),
      grantedBy: seat.originBoot.ownerPartyId,
    });

    expect(
      seat.gateway.invoke(audience.credential, {
        command: "core.add_document",
        input: {
          folder_id: seat.folderId,
          title: "Hotel",
          data_uri: "data:text/plain,hotel",
        },
      })
    ).toMatchObject({
      status: "denied",
      reason: "co-contribution to docs.folder is not offered in v1",
    });
    expect(
      seat.gateway.invoke(seat.owner, {
        command: "core.add_document",
        input: {
          folder_id: seat.folderId,
          title: "Hotel",
          data_uri: "data:text/plain,hotel",
        },
      }).status
    ).toBe("executed");
  });

  test("a party no grant names is left to the layer that was already deciding", () => {
    const seat = docsSeat();
    const stranger = audienceAgent(seat);
    const other = audienceAgent(seat, "asha-seat");
    createShareGrant(seat.origin.vault, {
      audience: { kind: "party", id: other.partyId },
      subjectType: "docs.folder",
      subjectId: seat.folderId,
      capability: "view",
      grantedAt: nowIso(),
      grantedBy: seat.originBoot.ownerPartyId,
    });

    const outcome = seat.gateway.invoke(stranger.credential, {
      command: "core.edit_document",
      input: { document_id: seat.documentId, body_text: "Amended" },
    });
    expect(outcome.status).not.toBe("denied");
  });

  test("a view-only audience is refused even where another audience holds edit", () => {
    const seat = docsSeat();
    const editor = audienceAgent(seat, "ravi-seat");
    const viewer = audienceAgent(seat, "asha-seat");
    const stranger = audienceAgent(seat, "dev-seat");
    const now = nowIso();
    const commons = createCommonsGrant({
      origin: seat.origin.vault,
      ownerPartyId: seat.originBoot.ownerPartyId,
      containerType: "docs.folder",
      containerId: seat.folderId,
      members: [{ partyId: editor.partyId, capability: "read+write" }],
      now,
    });
    for (const [audience, capability] of [
      [editor, "edit"],
      [viewer, "view"],
    ] as const)
      createShareGrant(seat.origin.vault, {
        audience: { kind: "party", id: audience.partyId },
        subjectType: "docs.folder",
        subjectId: seat.folderId,
        capability,
        grantedAt: now,
        grantedBy: seat.originBoot.ownerPartyId,
      });
    const edit = {
      command: "core.edit_document",
      input: { document_id: seat.documentId, body_text: "Amended" },
    };
    const opCount = () =>
      (
        seat.origin.vault
          .prepare(
            `SELECT COUNT(*) AS n FROM share_commons_op
              WHERE grant_id = ? AND command = 'core.edit_document'`
          )
          .get(commons.grantId) as { n: number }
      ).n;

    // Container-level edit grant is Ravi's; Asha is still view-only.
    expect(seat.gateway.invoke(viewer.credential, edit)).toMatchObject({
      status: "denied",
      reason: `core.edit_document writes into docs.folder ${seat.folderId}, which is shared for view only`,
    });
    // Seam refusal is before the rail; owner-fallback never sequences.
    expect(opCount()).toBe(0);

    expect(seat.gateway.invoke(editor.credential, edit).status).toBe(
      "executed"
    );
    expect(opCount()).toBe(1);
    expect(seat.gateway.invoke(seat.owner, edit).status).toBe("executed");
    expect(seat.gateway.invoke(stranger.credential, edit).status).not.toBe(
      "denied"
    );
  });

  test("commons delegation is unchanged where the grant plane refuses nothing", () => {
    const seat = docsSeat();
    const audience = audienceAgent(seat);
    const now = nowIso();
    const commons = createCommonsGrant({
      origin: seat.origin.vault,
      ownerPartyId: seat.originBoot.ownerPartyId,
      containerType: "docs.folder",
      containerId: seat.folderId,
      members: [{ partyId: audience.partyId, capability: "read+write" }],
      now,
    });
    createShareGrant(seat.origin.vault, {
      audience: { kind: "party", id: audience.partyId },
      subjectType: "docs.folder",
      subjectId: seat.folderId,
      capability: "edit",
      grantedAt: now,
      grantedBy: seat.originBoot.ownerPartyId,
    });

    const outcome = seat.gateway.invoke(seat.owner, {
      command: "core.edit_document",
      input: { document_id: seat.documentId, body_text: "Amended" },
    });
    expect(outcome.status).toBe("executed");
    expect(
      seat.origin.vault
        .prepare(
          `SELECT COUNT(*) AS n FROM share_commons_op
            WHERE grant_id = ? AND command = 'core.edit_document'`
        )
        .get(commons.grantId)
    ).toMatchObject({ n: 1 });
  });
});
