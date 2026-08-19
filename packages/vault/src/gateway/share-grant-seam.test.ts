// THE GRANT PLANE'S SEAM INTO THE ONE WRITE DOOR (issue #825, ruling G-edit).
//
// `routeShareGrantEdit` answers about a CONTAINER, not about a writer: it
// returns a route — refusals included — whenever any grant covers the
// container, view grants and edit grants alike. Wired raw into `invoke`, that
// would refuse the OWNER's own edits to a folder they shared for view, which
// would make sharing a way to lock yourself out of your own vault. So the
// seam is actor-aware, and these tests are the three claims that makes:
//
//   (a) the owner's own write is never refused by the owner's own grant;
//   (b) a write made on behalf of a party a grant NAMES does consult the
//       refusals — view-only, and folder co-contribution, which v1 defers —
//       and consults the refusals THAT PARTY'S OWN grants imply: a container
//       shared to one audience for edit and another for view refuses the
//       second, whose write would otherwise ride the rail attributed to the
//       owner by the commons arm's actor fallback;
//   (c) commons delegation is untouched: a write the grant plane has nothing
//       to say about still routes to the rail and sequences there.
//
// The first describe below answers the question those claims do not: WHERE
// edit enforcement lives for the path a household actually uses. The grant
// plane's door is the ORIGIN vault's — a non-owner party credential there,
// such as an enrolled agent. A member writing at their own seat is their own
// vault's owner and holds no `share_grant` rows at all (grants are never
// projected, asserted below), so their write is governed by the commons rail
// and its steward authorization, exactly as it was before the grant plane.
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

/** One vault, Docs commands registered, a folder and a document inside it. */
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

/**
 * A credential that acts as a party who is NOT the vault owner. An enrolled
 * agent is the one such principal this door actually sees, and its own party
 * is what the grants below name as their audience.
 */
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

    // THE DISCLOSURE, AS A TESTED FACT: `share_grant` rows live in the vault
    // that issued them and are never projected. A member sitting at their own
    // seat therefore has no grant plane to consult even in principle — and is
    // that vault's own owner besides, which short-circuits the seam.
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
    // Nothing about that outcome came from the grant plane: it is the commons
    // rail's own answer, because execution belongs to the steward's seat.
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

    // Executed at the steward's seat, sequenced on the rail, replayed back
    // onto the member's seat — the whole edit path, end to end.
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

    // The #750 rule at the seam: a write with nowhere to land is refused, not
    // applied privately where the next compile would silently revert it.
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

    // The router itself DOES refuse this container — that is exactly why the
    // seam has to ask who is writing before it listens to the answer.
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
      // The engine's own sentence, not a paraphrase invented at this seam.
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

    // v1 does not offer adding a document to someone else's shared folder.
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
    // The owner filing into their OWN folder is not co-contribution at all.
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

    // The grant plane addressed `other`, so it has nothing to say about
    // `stranger` — whose write is decided by consent, as it was before.
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

    // THE BUG THIS TEST EXISTS FOR: the container carries an edit grant, so
    // the container-level refusal is silent — but it is Ravi's, not Asha's.
    expect(seat.gateway.invoke(viewer.credential, edit)).toMatchObject({
      status: "denied",
      reason: `core.edit_document writes into docs.folder ${seat.folderId}, which is shared for view only`,
    });
    // Refused at the seam means refused BEFORE the rail: no op is sequenced,
    // so the owner-fallback actor in the commons arm never gets to attribute
    // Asha's write to the owner and execute it.
    expect(opCount()).toBe(0);

    // The party the edit grant does name still delegates to the rail.
    expect(seat.gateway.invoke(editor.credential, edit).status).toBe(
      "executed"
    );
    expect(opCount()).toBe(1);
    // The owner's own write is still the owner's own.
    expect(seat.gateway.invoke(seat.owner, edit).status).toBe("executed");
    // And a party no grant here names is still left to consent.
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
    // The write went down the commons rail, exactly as it did before the seam.
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
