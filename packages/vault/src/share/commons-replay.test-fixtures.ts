// Shared fixtures for the Commons command-tail replay suites (issue #750
// invariant 7). A shared drive folder is the container type with a real
// declared write surface, so every write these suites make travels through
// the same authorization, sequencing and fan-out path production uses.
//
// Split from `commons-replay.test.ts` / `commons-increment.test.ts` for the
// repo file-size cap; both suites stand up the same shape of world and must
// not drift apart by copy-paste.

import { registerDocumentCommands } from "../commands/documents.js";
import { createGateway } from "../gateway/gateway.js";
import type { Gateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import { nowIso, uuidv7 } from "../ids.js";
import {
  compileCommons,
  createCommonsGrant,
  executeCommonsCommand,
} from "./commons.js";
import type { CommonsMemberInput } from "./commons.js";
import { household } from "./placement-fixture.js";
import type { Household } from "./placement-fixture.js";

export const STEWARD_VAULT = "vault-priya";
export const MEMBER_VAULT = "vault-family";

export interface Side {
  gateway: Gateway;
  credential: Credential;
}

/** The host seam a co-hosted or remote replica catches up through: the seat's
 * own gateway on the canonical Commons rail, seeded so a replayed command
 * mints exactly the ids the steward minted. */
export function replicaExecutor(
  side: Side
): (
  command: string,
  input: Record<string, unknown>,
  invocationId: string
) => ReturnType<Gateway["invokeCommonsCanonical"]> {
  return (command, input, invocationId) =>
    side.gateway.invokeCommonsCanonical(
      side.credential,
      { command, input, purpose: "dpv:ServiceProvision", invocationId },
      { idSeed: invocationId }
    );
}

export interface FolderCommons {
  home: Household;
  grantId: string;
  folderId: string;
  documents: string[];
  steward: Side;
  member: Side;
  /** Member seats for the LOCAL rail, wired for replay unless told otherwise. */
  seats: (options?: { replay?: boolean }) => CommonsMemberInput[];
  /** One steward write through the real Commons rail (execute + sequence +
   * fan out to the supplied seats). */
  write: (
    command: string,
    input: Record<string, unknown>,
    options?: { seats?: CommonsMemberInput[] }
  ) => void;
  compile: (options?: {
    seats?: CommonsMemberInput[];
    forceFullProjection?: boolean;
  }) => void;
  documentTitle: (documentId: string) => string | undefined;
}

/** A shared drive folder: the container type with a real declared write
 * surface, so every write in these tests goes through the same authorization,
 * sequencing and fan-out path production uses. */
export function folderCommons(documentCount: number): FolderCommons {
  const home = household();
  const now = nowIso();
  const stewardGateway = createGateway(home.origin);
  registerDocumentCommands(stewardGateway);
  const memberGateway = createGateway(home.audience);
  registerDocumentCommands(memberGateway);
  const steward: Side = {
    gateway: stewardGateway,
    credential: {
      kind: "device",
      deviceId: home.originBoot.deviceId,
      deviceKey: home.originBoot.deviceKey,
    },
  };
  const member: Side = {
    gateway: memberGateway,
    credential: {
      kind: "device",
      deviceId: home.audienceBoot.deviceId,
      deviceKey: home.audienceBoot.deviceKey,
    },
  };
  const invoke = (
    command: string,
    input: Record<string, unknown>
  ): Record<string, unknown> => {
    const outcome = stewardGateway.invoke(steward.credential, {
      command,
      input,
      purpose: "dpv:ServiceProvision",
    });
    if (outcome.status !== "executed")
      throw new Error(`${command} failed: ${JSON.stringify(outcome)}`);
    return outcome.output as Record<string, unknown>;
  };
  const folderId = String(
    invoke("core.create_folder", { name: "Trip" })["folder_id"]
  );
  const documents = Array.from({ length: documentCount }, (_, index) =>
    String(
      invoke("core.add_document", {
        folder_id: folderId,
        title: `Booking ${index}`,
        data_uri: `data:text/plain,booking-${index}`,
      })["document_id"]
    )
  );
  const grant = createCommonsGrant({
    origin: home.origin.vault,
    ownerPartyId: home.originBoot.ownerPartyId,
    ownerVaultId: STEWARD_VAULT,
    ownerVault: home.origin,
    containerType: "docs.folder",
    containerId: folderId,
    members: [
      {
        partyId: home.audienceBoot.ownerPartyId,
        capability: "read+write",
        vaultId: MEMBER_VAULT,
        vault: home.audience,
      },
    ],
    now,
  });
  const seats = (options?: { replay?: boolean }): CommonsMemberInput[] => [
    {
      partyId: home.audienceBoot.ownerPartyId,
      capability: "read+write",
      vaultId: MEMBER_VAULT,
      vault: home.audience,
      ...(options?.replay === false
        ? {}
        : { applyCommand: replicaExecutor(member) }),
    },
  ];
  const compile = (options?: {
    seats?: CommonsMemberInput[];
    forceFullProjection?: boolean;
  }): void => {
    compileCommons({
      steward: home.origin,
      stewardVaultId: STEWARD_VAULT,
      grantId: grant.grantId,
      seats: options?.seats ?? seats(),
      now: nowIso(),
      ...(options?.forceFullProjection ? { forceFullProjection: true } : {}),
    });
  };
  compile({ seats: seats({ replay: false }) });
  return {
    home,
    grantId: grant.grantId,
    folderId,
    documents,
    steward,
    member,
    seats,
    compile,
    write: (command, input, options) => {
      const answer = executeCommonsCommand({
        steward: home.origin,
        gateway: stewardGateway,
        credential: steward.credential,
        stewardVaultId: STEWARD_VAULT,
        grantId: grant.grantId,
        actorPartyId: home.originBoot.ownerPartyId,
        command,
        commandInput: input,
        seats: options?.seats ?? seats(),
        now: nowIso(),
      });
      if (!answer.decision.accepted)
        throw new Error(
          `commons write ${command} refused: ${String(answer.decision.reason)}`
        );
    },
    documentTitle: (documentId) =>
      (
        home.audience.vault
          .prepare("SELECT title FROM core_document WHERE document_id = ?")
          .get(documentId) as { title: string } | undefined
      )?.title,
  };
}

/** Seat-local intelligence for every projected document: exactly the state a
 * destructive re-projection deletes and a replayed tail must leave alone. */
export function seedMemberDerivedState(
  fixture: FolderCommons,
  needle: string
): { embeddings: number } {
  const { audience } = fixture.home;
  const now = nowIso();
  const contentIds = (
    audience.vault
      .prepare("SELECT current_content_id AS id FROM core_document")
      .all() as { id: string }[]
  ).map((row) => row.id);
  const insertEmbedding = audience.vault.prepare(
    `INSERT INTO enrich_embedding
       (embedding_id, target_type, target_id, model, dim, vector, created_at)
     VALUES (?, 'core.content_item', ?, 'test@1', 1, ?, ?)`
  );
  for (const contentId of contentIds)
    insertEmbedding.run(
      uuidv7(),
      contentId,
      Buffer.from(new Float32Array([1]).buffer),
      now
    );
  // A member-authored OCR/text derivative — seat-local truth the steward
  // never had and can never resend.
  audience.vault
    .prepare(
      `INSERT INTO core_content_derivative
         (derivative_id, content_id, variant, sha256, media_type,
          byte_size, text_content, created_at)
       VALUES (?, ?, 'text', NULL, 'text/plain', ?, ?, ?)`
    )
    .run(uuidv7(), contentIds[0]!, needle.length, needle, now);
  audience.vault
    .prepare(
      "UPDATE enrich_request SET drained_at = ? WHERE drained_at IS NULL"
    )
    .run(now);
  return { embeddings: contentIds.length };
}

export function memberEmbeddings(fixture: FolderCommons): number {
  return (
    fixture.home.audience.vault
      .prepare("SELECT COUNT(*) AS n FROM enrich_embedding")
      .get() as {
      n: number;
    }
  ).n;
}

export function memberOcrHits(fixture: FolderCommons, needle: string): number {
  return (
    fixture.home.audience.vault
      .prepare(
        `SELECT COUNT(*) AS n FROM fts_core_content_item
          WHERE fts_core_content_item MATCH ?`
      )
      .get(needle) as { n: number }
  ).n;
}
