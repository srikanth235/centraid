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
//       refusals — view-only, and folder co-contribution, which v1 defers;
//   (c) commons delegation is untouched: a write the grant plane has nothing
//       to say about still routes to the rail and sequences there.
import { afterEach, describe, expect, test } from "vitest";

import { createGrant, enrollAgent, enrollDevice } from "../bootstrap.js";
import { registerDocumentCommands } from "../commands/documents.js";
import { createShareGrant } from "../grant/grant-store.js";
import { nowIso } from "../ids.js";
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
  const device = enrollDevice(seat.origin, seat.originBoot.ownerPartyId, "host");
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
