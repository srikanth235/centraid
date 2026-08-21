import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { bootstrapVault } from "../bootstrap.js";
import { registerDocumentCommands } from "../commands/documents.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { createGateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import { nowIso, uuidv7 } from "../ids.js";
import { vaultIdentityPublicKey } from "../schema/vault-identity.js";
import { placeCommonsBootstrapBlobs } from "./commons-blobs.test-fixtures.js";
import {
  answerCommonsInvitation,
  applyCommonsBootstrap,
  claimCommonsInvitation,
  createCommonsClaimInvitation,
  exportCommonsBootstrap,
  listCommonsInvitations,
  queueCommonsInvitation,
} from "./commons-bootstrap.js";
import {
  commonsSeats,
  revokeCommonsGrant,
  scrubCommonsSeat,
  upsertCommonsMember,
} from "./commons-lifecycle.js";
import { signCommonsIntent } from "./commons-signature.js";
import {
  compileCommons,
  createCommonsGrant,
  executeCommonsCommand,
  retainCommonsItem,
} from "./commons.js";

interface Seat {
  vaultId: string;
  db: VaultDb;
  ownerPartyId: string;
  credential: Credential;
}

const opened: VaultDb[] = [];
const roots: string[] = [];

function openSeat(root: string, vaultId: string, ownerName: string): Seat {
  const dir = path.join(root, vaultId);
  mkdirSync(dir, { recursive: true });
  const db = openVaultDb({ dir });
  opened.push(db);
  const boot = bootstrapVault(db, { vaultId, ownerName });
  return {
    vaultId,
    db,
    ownerPartyId: boot.ownerPartyId,
    credential: {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    },
  };
}

describe("B6 Docs folder Commons on one machine", () => {
  afterEach(() => {
    while (opened.length > 0) opened.pop()?.close();
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  test("a no-vault invite joins, folder-follow writes obey mixed capability, Save survives unshare, and re-invite works", () => {
    const root = tempDirSync("commons-docs-b6-local-");
    roots.push(root);
    const origin = openSeat(root, "vault-priya", "Priya");
    const reader = openSeat(root, "vault-reader", "Ravi");
    const now = nowIso();
    origin.db.vault
      .prepare(
        `INSERT INTO core_party
           (party_id, kind, display_name, sort_name, birth_date,
            avatar_content_id, created_at, updated_at, ontology_version)
         VALUES (?, 'person', 'Ravi', 'Ravi', NULL, NULL, ?, ?, '1.4')`
      )
      .run(reader.ownerPartyId, now, now);

    const originGateway = createGateway(origin.db);
    registerDocumentCommands(originGateway);
    const invokeOrigin = (
      command: string,
      input: Record<string, unknown>
    ): Record<string, unknown> => {
      const outcome = originGateway.invoke(origin.credential, {
        command,
        input,
      });
      if (outcome.status !== "executed")
        throw new Error(`${command} failed: ${JSON.stringify(outcome)}`);
      return outcome.output as Record<string, unknown>;
    };
    const trip = (
      invokeOrigin("core.create_folder", { name: "Trip" }) as {
        folder_id: string;
      }
    ).folder_id;
    const bookings = (
      invokeOrigin("core.create_folder", {
        name: "Bookings",
        parent_folder_id: trip,
      }) as { folder_id: string }
    ).folder_id;
    const first = invokeOrigin("core.add_document", {
      folder_id: bookings,
      title: "Train ticket",
      data_uri: "data:text/plain,train-ticket-bytes",
    }) as { document_id: string; content_id: string };

    const invitedPartyId = "party-writer-before-centraid";
    const grant = createCommonsGrant({
      origin: origin.db.vault,
      ownerPartyId: origin.ownerPartyId,
      ownerVaultId: origin.vaultId,
      ownerVault: origin.db,
      containerType: "docs.folder",
      containerId: trip,
      members: [
        { partyId: invitedPartyId, capability: "read+write" },
        {
          partyId: reader.ownerPartyId,
          capability: "read",
          vaultId: reader.vaultId,
          vault: reader.db,
        },
      ],
      now,
    });
    const vaultFor = (vaultId: string) =>
      vaultId === origin.vaultId
        ? origin.db
        : vaultId === reader.vaultId
          ? reader.db
          : vaultId === "vault-writer"
            ? writer?.db
            : undefined;
    const allSeats = () =>
      commonsSeats({
        steward: origin.db.vault,
        grantId: grant.grantId,
        stewardVaultId: origin.vaultId,
        vaultFor,
      });
    const compile = () =>
      compileCommons({
        steward: origin.db,
        stewardVaultId: origin.vaultId,
        grantId: grant.grantId,
        seats: allSeats(),
        now,
      });
    // oxlint-disable-next-line prefer-const -- the pre-install invite proof must run before this seat exists
    let writer: Seat | undefined;
    compile();
    const invited = allSeats().find((seat) => seat.partyId === invitedPartyId);
    expect(invited).toStrictEqual({
      partyId: invitedPartyId,
      capability: "read+write",
    });
    const readerWire = exportCommonsBootstrap({
      steward: origin.db.vault,
      identitySeed: origin.db.identitySeed,
      stewardVaultId: origin.vaultId,
      grantId: grant.grantId,
      memberVaultId: reader.vaultId,
    });
    const claim = createCommonsClaimInvitation({
      seat: origin.db.vault,
      invitation: {
        grantId: grant.grantId,
        stewardVaultId: origin.vaultId,
        memberPartyId: invitedPartyId,
        capability: "read+write",
        containerType: "docs.folder",
        containerId: trip,
        containerLabel: "Trip",
        currentSizeBytes: readerWire.closure.blobs.reduce(
          (sum, blob) => sum + blob.size,
          0
        ),
      },
      now,
    });
    expect(claim.invitation.memberVaultId).toBeUndefined();

    // Install/create happens only after the raw one-time invite URI exists.
    writer = openSeat(root, "vault-writer", "Wren");
    const claimed = claimCommonsInvitation({
      steward: origin.db.vault,
      claimToken: claim.claimToken,
      memberVaultId: writer.vaultId,
      memberVaultPublicKey: vaultIdentityPublicKey(
        writer.db.identitySeed
      ).toString("base64"),
      now,
    });
    const pending = queueCommonsInvitation({
      seat: writer.db.vault,
      invitation: { ...claimed, memberVaultId: writer.vaultId },
      now,
    });
    expect(
      writer.db.vault.prepare("SELECT COUNT(*) AS n FROM core_document").get()
    ).toMatchObject({ n: 0 });
    expect(
      listCommonsInvitations({
        seat: writer.db.vault,
        memberVaultId: writer.vaultId,
      })[0]
    ).toMatchObject({
      status: "pending",
      currentSizeBytes: claim.invitation.currentSizeBytes,
    });
    answerCommonsInvitation({
      seat: writer.db,
      invitationId: pending.invitationId,
      memberVaultId: writer.vaultId,
      answer: "accept",
      now,
    });
    upsertCommonsMember({
      steward: origin.db.vault,
      grantId: grant.grantId,
      actorPartyId: origin.ownerPartyId,
      member: {
        partyId: invitedPartyId,
        capability: "read+write",
        vaultId: writer.vaultId,
        vault: writer.db,
      },
      now,
    });
    const writerWire = exportCommonsBootstrap({
      steward: origin.db.vault,
      identitySeed: origin.db.identitySeed,
      stewardVaultId: origin.vaultId,
      grantId: grant.grantId,
      memberVaultId: writer.vaultId,
    });
    placeCommonsBootstrapBlobs({
      source: origin.db,
      seat: writer.db,
      wire: writerWire,
    });
    applyCommonsBootstrap({ seat: writer.db, wire: writerWire, now });

    const later = invokeOrigin("core.add_document", {
      folder_id: bookings,
      title: "Hotel receipt",
      data_uri: `data:application/pdf;base64,${Buffer.from(
        "hotel-receipt-bytes"
      ).toString("base64")}`,
    }) as { document_id: string; content_id: string };
    compile();
    for (const seat of [reader, writer]) {
      expect(
        seat.db.vault
          .prepare("SELECT title FROM core_document WHERE document_id = ?")
          .get(later.document_id)
      ).toMatchObject({ title: "Hotel receipt" });
      const content = seat.db.vault
        .prepare("SELECT sha256 FROM core_content_item WHERE content_id = ?")
        .get(later.content_id) as { sha256: string };
      expect(seat.db.blobs.local.hasSync(content.sha256)).toBe(true);
    }

    const writerInput = {
      folder_id: bookings,
      title: "Writer itinerary",
      data_uri: `data:application/pdf;base64,${Buffer.from(
        "writer-itinerary-bytes"
      ).toString("base64")}`,
    };
    const writerIntent = "local-docs-writer-add";
    expect(
      executeCommonsCommand({
        steward: origin.db,
        gateway: originGateway,
        credential: origin.credential,
        stewardVaultId: origin.vaultId,
        grantId: grant.grantId,
        actorPartyId: invitedPartyId,
        command: "core.add_document",
        commandInput: writerInput,
        memberSignature: sign(
          writer,
          grant.grantId,
          invitedPartyId,
          writerIntent,
          writerInput
        ),
        intentId: writerIntent,
        invocationId: writerIntent,
        seats: allSeats(),
        now,
      }).decision.accepted
    ).toBe(true);
    const readerInput = {
      folder_id: bookings,
      title: "Reader must not add",
      data_uri: "data:text/plain,reader-refused",
    };
    const refused = executeCommonsCommand({
      steward: origin.db,
      gateway: originGateway,
      credential: origin.credential,
      stewardVaultId: origin.vaultId,
      grantId: grant.grantId,
      actorPartyId: reader.ownerPartyId,
      command: "core.add_document",
      commandInput: readerInput,
      memberSignature: sign(
        reader,
        grant.grantId,
        reader.ownerPartyId,
        "local-docs-reader-refused",
        readerInput
      ),
      intentId: "local-docs-reader-refused",
      invocationId: "local-docs-reader-refused",
      seats: allSeats(),
      now,
    });
    expect(refused.decision).toMatchObject({
      accepted: false,
      reason: "this commons is read-only for this member",
    });

    // Derivatives and FTS are seat-local and must disappear with the reader's
    // projection; the writer deliberately retains the root as receiver-owned.
    reader.db.vault
      .prepare(
        `INSERT INTO core_content_derivative
           (derivative_id, content_id, variant, sha256, media_type,
            byte_size, text_content, created_at)
         VALUES (?, ?, 'text', NULL, 'text/plain', 25,
                 'onlyunsharedneedle', ?)`
      )
      .run(uuidv7(), first.content_id, now);
    expect(ftsCount(reader.db, "onlyunsharedneedle")).toBe(1);
    expect(
      retainCommonsItem({
        seat: writer.db.vault,
        itemType: "docs.folder",
        itemId: trip,
        now,
      })
    ).toMatchObject({ retained: true, grantIds: [grant.grantId] });
    const laterBootstrap = exportCommonsBootstrap({
      steward: origin.db.vault,
      identitySeed: origin.db.identitySeed,
      stewardVaultId: origin.vaultId,
      grantId: grant.grantId,
      memberVaultId: writer.vaultId,
    });
    applyCommonsBootstrap({ seat: writer.db, wire: laterBootstrap, now });
    revokeCommonsGrant({
      steward: origin.db.vault,
      grantId: grant.grantId,
      actorPartyId: origin.ownerPartyId,
      now,
    });
    scrubCommonsSeat({ seat: reader.db, grantId: grant.grantId });
    scrubCommonsSeat({ seat: writer.db, grantId: grant.grantId });
    expect(
      reader.db.vault.prepare("SELECT COUNT(*) AS n FROM core_document").get()
    ).toMatchObject({ n: 0 });
    expect(
      reader.db.vault
        .prepare("SELECT COUNT(*) AS n FROM core_content_derivative")
        .get()
    ).toMatchObject({ n: 0 });
    expect(ftsCount(reader.db, "onlyunsharedneedle")).toBe(0);
    expect(
      writer.db.vault
        .prepare("SELECT COUNT(*) AS n FROM core_concept WHERE concept_id = ?")
        .get(trip)
    ).toMatchObject({ n: 1 });
    expect(
      (
        writer.db.vault
          .prepare("SELECT COUNT(*) AS n FROM core_document")
          .get() as { n: number }
      ).n
    ).toBeGreaterThan(0);

    const reinvite = createCommonsGrant({
      origin: origin.db.vault,
      ownerPartyId: origin.ownerPartyId,
      ownerVaultId: origin.vaultId,
      ownerVault: origin.db,
      circleName: "Trip re-invite",
      containerType: "docs.folder",
      containerId: trip,
      members: [
        {
          partyId: reader.ownerPartyId,
          capability: "read",
          vaultId: reader.vaultId,
          vault: reader.db,
        },
      ],
      now,
    });
    compileCommons({
      steward: origin.db,
      stewardVaultId: origin.vaultId,
      grantId: reinvite.grantId,
      seats: commonsSeats({
        steward: origin.db.vault,
        grantId: reinvite.grantId,
        stewardVaultId: origin.vaultId,
        vaultFor: (vaultId) =>
          vaultId === origin.vaultId
            ? origin.db
            : vaultId === reader.vaultId
              ? reader.db
              : undefined,
      }),
      now,
    });
    expect(
      reader.db.vault
        .prepare("SELECT title FROM core_document WHERE document_id = ?")
        .get(later.document_id)
    ).toMatchObject({ title: "Hotel receipt" });
  });
});

function sign(
  seat: Seat,
  grantId: string,
  actorPartyId: string,
  nonce: string,
  commandInput: Record<string, unknown>
) {
  return signCommonsIntent(seat.db.identitySeed, {
    grantId,
    actorPartyId,
    command: "core.add_document",
    commandInput,
    memberVaultId: seat.vaultId,
    nonce,
  });
}

function ftsCount(db: VaultDb, query: string): number {
  return (
    db.vault
      .prepare(
        "SELECT COUNT(*) AS n FROM fts_core_document WHERE fts_core_document MATCH ?"
      )
      .get(query) as { n: number }
  ).n;
}
