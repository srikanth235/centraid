import { afterEach, describe, expect, test } from "vitest";

import { registerDocumentCommands } from "../commands/documents.js";
import { createGateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import { nowIso } from "../ids.js";
import { commonsSeats } from "./commons-lifecycle.js";
import {
  authorizeCommonsCommand,
  commonsGrantForCommand,
  compileCommons,
  createCommonsGrant,
} from "./commons.js";
import { closeOpenVaults, household } from "./placement-fixture.js";

describe("docs.folder Commons command boundary", () => {
  afterEach(closeOpenVaults);

  test("routes subtree writes, follows ordinary steward writes, and refuses sibling escape", () => {
    const { origin, originBoot, audience, audienceBoot } = household();
    const now = nowIso();
    // oxlint-disable-next-line prefer-const -- the callback must exist before the grant id is created
    let activeGrantId: string | undefined;
    const gateway = createGateway(origin, {
      onCommonsCommandSequenced: (grantId) => {
        if (grantId !== activeGrantId) return;
        compileCommons({
          steward: origin,
          stewardVaultId: "vault-priya",
          grantId,
          seats: commonsSeats({
            steward: origin.vault,
            grantId,
            stewardVaultId: "vault-priya",
            vaultFor: (vaultId) =>
              vaultId === "vault-family" ? audience : undefined,
          }),
          now: nowIso(),
        });
      },
    });
    registerDocumentCommands(gateway);
    const credential: Credential = {
      kind: "device",
      deviceId: originBoot.deviceId,
      deviceKey: originBoot.deviceKey,
    };
    const invoke = (command: string, input: Record<string, unknown>) => {
      const outcome = gateway.invoke(credential, { command, input });
      expect(outcome.status).toBe("executed");
      if (outcome.status !== "executed")
        throw new Error(`command failed: ${JSON.stringify(outcome)}`);
      return outcome.output;
    };
    const trip = (
      invoke("core.create_folder", { name: "Trip" }) as { folder_id: string }
    ).folder_id;
    const bookings = (
      invoke("core.create_folder", {
        name: "Bookings",
        parent_folder_id: trip,
      }) as { folder_id: string }
    ).folder_id;
    const personal = (
      invoke("core.create_folder", { name: "Personal" }) as {
        folder_id: string;
      }
    ).folder_id;
    const ticket = (
      invoke("core.add_document", {
        folder_id: bookings,
        title: "Train ticket",
        data_uri: "data:text/plain,train",
      }) as { document_id: string }
    ).document_id;

    const grant = createCommonsGrant({
      origin: origin.vault,
      ownerPartyId: originBoot.ownerPartyId,
      ownerVaultId: "vault-priya",
      ownerVault: origin,
      containerType: "docs.folder",
      containerId: trip,
      members: [
        {
          partyId: audienceBoot.ownerPartyId,
          capability: "read",
          vaultId: "vault-family",
          vault: audience,
        },
      ],
      now,
    });
    activeGrantId = grant.grantId;
    compileCommons({
      steward: origin,
      stewardVaultId: "vault-priya",
      grantId: grant.grantId,
      seats: commonsSeats({
        steward: origin.vault,
        grantId: grant.grantId,
        stewardVaultId: "vault-priya",
        vaultFor: (vaultId) =>
          vaultId === "vault-family" ? audience : undefined,
      }),
      now,
    });

    expect(
      commonsGrantForCommand(origin.vault, "core.add_document", {
        folder_id: bookings,
      })?.grantId
    ).toBe(grant.grantId);
    expect(
      commonsGrantForCommand(origin.vault, "core.create_folder", {
        parent_folder_id: bookings,
      })?.grantId
    ).toBe(grant.grantId);
    expect(
      commonsGrantForCommand(origin.vault, "core.rename_folder", {
        folder_id: bookings,
      })?.grantId
    ).toBe(grant.grantId);
    expect(
      commonsGrantForCommand(origin.vault, "core.rename_document", {
        document_id: ticket,
      })?.grantId
    ).toBe(grant.grantId);
    expect(
      commonsGrantForCommand(origin.vault, "core.add_document", {
        folder_id: personal,
      })
    ).toBeUndefined();
    expect(
      commonsGrantForCommand(origin.vault, "core.delete_folder", {
        folder_id: trip,
      })?.grantId
    ).toBe(grant.grantId);

    const later = (
      invoke("core.add_document", {
        folder_id: bookings,
        title: "Hotel",
        data_uri: "data:text/plain,hotel",
      }) as { document_id: string }
    ).document_id;
    expect(
      audience.vault
        .prepare("SELECT title FROM core_document WHERE document_id = ?")
        .get(later)
    ).toMatchObject({ title: "Hotel" });
    expect(
      origin.vault
        .prepare(
          "SELECT command FROM share_commons_op WHERE grant_id = ? ORDER BY sequence"
        )
        .all(grant.grantId)
    ).toMatchObject([{ command: "core.add_document" }]);
    expect(
      gateway.invoke(credential, {
        command: "core.delete_folder",
        input: { folder_id: trip },
      })
    ).toMatchObject({
      status: "denied",
      reason: "command core.delete_folder is not declared for docs.folder",
    });
    expect(
      origin.vault
        .prepare("SELECT pref_label FROM core_concept WHERE concept_id = ?")
        .get(trip)
    ).toMatchObject({ pref_label: "Trip" });
    expect(
      origin.vault
        .prepare(
          "SELECT command FROM share_commons_op WHERE grant_id = ? ORDER BY sequence"
        )
        .all(grant.grantId)
    ).toMatchObject([{ command: "core.add_document" }]);

    expect(
      authorizeCommonsCommand({
        steward: origin.vault,
        grantId: grant.grantId,
        actorPartyId: audienceBoot.ownerPartyId,
        command: "core.rename_document",
        commandInput: { document_id: later, title: "Nope" },
        now,
      })
    ).toMatchObject({
      accepted: false,
      reason: "this commons is read-only for this member",
    });
    origin.vault
      .prepare(
        "UPDATE social_circle_member SET capability = 'read+write' WHERE circle_id = ? AND party_id = ?"
      )
      .run(grant.circleId, audienceBoot.ownerPartyId);
    expect(
      authorizeCommonsCommand({
        steward: origin.vault,
        grantId: grant.grantId,
        actorPartyId: audienceBoot.ownerPartyId,
        command: "core.move_document",
        commandInput: { document_id: later, folder_id: personal },
        now,
      })
    ).toMatchObject({
      accepted: false,
      reason: "command does not target this docs.folder",
    });
  });
});
