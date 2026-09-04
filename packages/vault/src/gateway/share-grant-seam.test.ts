// Grant-plane seam into invoke (#825, G-edit). `routeShareGrantEdit` answers
// about a container, not a writer; the seam is actor-aware so the owner's own
// grant never refuses the owner's write. Grants never project — own-seat
// writes ride the commons rail. `tally.group` is v1's ONE edit subject, so
// every EDIT claim below stands on a group; the VIEW claims stay on a folder,
// which the registry still answers for view.
import { afterEach, describe, expect, test } from "vitest";

import { createGrant, enrollAgent, enrollDevice } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { registerDocumentCommands } from "../commands/documents.js";
import { registerTallyCommands } from "../commands/tally.js";
import type { VaultDb } from "../db.js";
import { createShareGrant } from "../grant/grant-store.js";
import { nowIso } from "../ids.js";
import {
  MEMBER_VAULT,
  STEWARD_VAULT,
} from "../share/commons-replay.test-fixtures.js";
import {
  compileCommons,
  createCommonsGrant,
  executeCommonsCommand,
} from "../share/commons.js";
import type { CommonsMemberInput } from "../share/commons.js";
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
  const commonsOps = (grantId: string, command: string) =>
    (
      origin.vault
        .prepare(
          `SELECT COUNT(*) AS n FROM share_commons_op
            WHERE grant_id = ? AND command = ?`
        )
        .get(grantId, command) as { n: number }
    ).n;
  return { origin, originBoot, gateway, owner, invoke, commonsOps };
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

/** v1's one EDIT subject. A commons over a group must name that circle's
 *  EXACT roster, so the audience joins the group first. */
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
    railFor: (groupId: string, memberPartyIds: string[], now: string) =>
      createCommonsGrant({
        origin: seat.origin.vault,
        ownerPartyId: seat.originBoot.ownerPartyId,
        containerType: "tally.group",
        containerId: groupId,
        members: memberPartyIds.map((partyId) => ({
          partyId,
          capability: "read+write" as const,
        })),
        now,
      }),
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

/** A Tally group commons across two real vaults, so a member's own-seat
 *  write has a real rail to ride. */
function tallyCommonsHome() {
  const home = household();
  const now = nowIso();
  const stewardGateway = createGateway(home.origin);
  registerTallyCommands(stewardGateway);
  const memberGateway = createGateway(home.audience);
  registerTallyCommands(memberGateway);
  const steward: Credential = {
    kind: "device",
    deviceId: home.originBoot.deviceId,
    deviceKey: home.originBoot.deviceKey,
  };
  const member: Credential = {
    kind: "device",
    deviceId: home.audienceBoot.deviceId,
    deviceKey: home.audienceBoot.deviceKey,
  };
  const memberPartyId = home.audienceBoot.ownerPartyId;
  // The member is a party at the ORIGIN before the group can name them.
  home.origin.vault
    .prepare(
      `INSERT INTO core_party
         (party_id, kind, display_name, sort_name, birth_date,
          avatar_content_id, created_at, updated_at)
       VALUES (?, 'person', 'Family', 'Family', NULL, NULL, ?, ?)`
    )
    .run(memberPartyId, now, now);
  const created = stewardGateway.invoke(steward, {
    command: "tally.create_group",
    input: { name: "Trip", icon: "🧳", member_ids: [memberPartyId] },
  });
  if (created.status !== "executed")
    throw new Error(`group creation failed: ${JSON.stringify(created)}`);
  const groupId = (created.output as { group_id: string }).group_id;
  const grant = createCommonsGrant({
    origin: home.origin.vault,
    ownerPartyId: home.originBoot.ownerPartyId,
    ownerVaultId: STEWARD_VAULT,
    ownerVault: home.origin,
    containerType: "tally.group",
    containerId: groupId,
    members: [
      {
        partyId: memberPartyId,
        capability: "read+write",
        vaultId: MEMBER_VAULT,
        vault: home.audience,
      },
    ],
    now,
  });
  const seats: CommonsMemberInput[] = [
    {
      partyId: home.originBoot.ownerPartyId,
      capability: "read+write",
      vaultId: STEWARD_VAULT,
      vault: home.origin,
    },
    {
      partyId: memberPartyId,
      capability: "read+write",
      vaultId: MEMBER_VAULT,
      vault: home.audience,
    },
  ];
  compileCommons({
    steward: home.origin,
    stewardVaultId: STEWARD_VAULT,
    grantId: grant.grantId,
    seats,
    now,
  });
  return {
    home,
    groupId,
    grantId: grant.grantId,
    memberPartyId,
    memberGateway,
    member,
    /** One steward write through the real rail: execute, sequence, fan out. */
    write: (command: string, input: Record<string, unknown>) => {
      const answer = executeCommonsCommand({
        steward: home.origin,
        gateway: stewardGateway,
        credential: steward,
        stewardVaultId: STEWARD_VAULT,
        grantId: grant.grantId,
        actorPartyId: home.originBoot.ownerPartyId,
        command,
        commandInput: input,
        seats,
        now: nowIso(),
      });
      if (!answer.decision.accepted)
        throw new Error(
          `commons write ${command} refused: ${String(answer.decision.reason)}`
        );
    },
    /** The group's name as the MEMBER's own seat sees it. */
    memberGroupName: () =>
      (
        home.audience.vault
          .prepare(
            `SELECT c.name AS name FROM social_circle c
               JOIN tally_group g ON g.circle_id = c.circle_id
              WHERE g.group_id = ?`
          )
          .get(groupId) as { name: string } | undefined
      )?.name,
  };
}

describe("where an audience's edit is actually enforced", () => {
  afterEach(closeOpenVaults);

  test("a member's own-seat edit rides the commons rail; grants stay origin-only", () => {
    const fixture = tallyCommonsHome();
    createShareGrant(fixture.home.origin.vault, {
      audience: { kind: "party", id: fixture.memberPartyId },
      subjectType: "tally.group",
      subjectId: fixture.groupId,
      capability: "edit",
      grantedAt: nowIso(),
      grantedBy: fixture.home.originBoot.ownerPartyId,
    });

    // Counted over the SHARE lens: the audience seat has device-kind rows of
    // its own that are not shares (#883).
    expect(
      fixture.home.audience.vault
        .prepare(
          `SELECT COUNT(*) AS n FROM share_authority
            WHERE principal_kind IN ('person','circle')`
        )
        .get()
    ).toMatchObject({ n: 0 });

    const edit = { group_id: fixture.groupId, name: "Museum trip" };
    const queued = fixture.memberGateway.invoke(fixture.member, {
      command: "tally.rename_group",
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
    expect(fixture.memberGroupName()).toBe("Trip");

    fixture.write("tally.rename_group", edit);
    expect(fixture.memberGroupName()).toBe("Museum trip");
    expect(
      fixture.home.origin.vault
        .prepare(
          `SELECT COUNT(*) AS n FROM share_commons_op
            WHERE grant_id = ? AND command = 'tally.rename_group'`
        )
        .get(fixture.grantId)
    ).toMatchObject({ n: 1 });
  });

  /**
   * THE GRANT IS THE RAIL (#929). A member's write is a signed replica intent
   * the ORIGIN executes, so an audience with an `edit` answer over a container
   * this vault owns needs no second rail row: the write lands here, which is
   * the container's home. What still refuses is a `view` answer — and it
   * refuses BY NAME, so nothing is applied privately.
   */
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
    const commons = seat.railFor(groupId, [editor.partyId], now);
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
    // tally.group is the ONE container whose audience may co-contribute in v1
    // (G-edit), so an edit-bearing audience is refused nothing and the add
    // lands on the rail. The refusal every OTHER container still answers is
    // unit-pinned on `shareGrantEditRefusal` (grant/fulfillment-edit.test.ts).
    expect(
      seat.gateway.invoke(editor.credential, expense("Hotel")).status
    ).toBe("executed");
    expect(seat.gateway.invoke(seat.owner, expense("Museum")).status).toBe(
      "executed"
    );
    expect(seat.commonsOps(commons.grantId, "tally.add_expense")).toBe(2);
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
    const commons = seat.railFor(groupId, [editor.partyId], now);
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
    const opCount = () =>
      seat.commonsOps(commons.grantId, "tally.rename_group");

    // Container-level edit grant is Ravi's; Asha is still view-only.
    expect(seat.gateway.invoke(viewer.credential, rename)).toMatchObject({
      status: "denied",
      reason: `tally.rename_group writes into tally.group ${groupId}, which is shared for view only`,
    });
    // Seam refusal is before the rail; owner-fallback never sequences.
    expect(opCount()).toBe(0);

    expect(seat.gateway.invoke(editor.credential, rename).status).toBe(
      "executed"
    );
    expect(opCount()).toBe(1);
    expect(seat.gateway.invoke(seat.owner, rename).status).toBe("executed");
    expect(seat.gateway.invoke(stranger.credential, rename).status).not.toBe(
      "denied"
    );
  });

  test("commons delegation is unchanged where the grant plane refuses nothing", () => {
    const seat = tallySeat();
    const audience = audienceAgent(seat, "ravi-seat", "tally");
    const groupId = seat.createGroup([audience.partyId]);
    const now = nowIso();
    const commons = seat.railFor(groupId, [audience.partyId], now);
    grantTo(seat, audience, { type: "tally.group", id: groupId }, "edit", now);

    const outcome = seat.gateway.invoke(seat.owner, {
      command: "tally.rename_group",
      input: { group_id: groupId, name: "Museum trip" },
    });
    expect(outcome.status).toBe("executed");
    expect(seat.commonsOps(commons.grantId, "tally.rename_group")).toBe(1);
  });
});
