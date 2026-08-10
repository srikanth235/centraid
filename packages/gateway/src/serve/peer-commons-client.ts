/** Dialing half of Commons peer sync and signed member-command delivery. */

import { createHash } from "node:crypto";

import {
  applyCommonsBootstrap,
  applyCommonsTombstone,
  commonsClosureSizeBytes,
  queueCommonsInvitation,
  readCommonsCursor,
} from "@centraid/vault";
import type {
  CommonsBootstrap,
  CommonsInvitationRecord,
  CommonsMemberSignature,
  CommonsTombstone,
  VaultDb,
} from "@centraid/vault";

import {
  PEER_COMMONS_BLOB_PATH,
  PEER_COMMONS_BOOTSTRAP_PATH_PREFIX,
  PEER_COMMONS_COMMAND_PATH,
  PEER_COMMONS_CLAIM_PATH,
  PEER_COMMONS_INVITE_PATH,
  PEER_COMMONS_REFUSE_PATH,
} from "../routes/peer-commons-route.js";
import type { PeerDial, PeerDialRoute } from "./peer-edge-give-client.js";

const CHUNK_BYTES = 1024 * 1024;

function endpoint(dial: PeerDial, route: PeerDialRoute): string {
  return dial.endpointTicketFor(route.endpointId, route.relayHints);
}

function query(input: {
  stewardVaultId: string;
  memberVaultId: string;
}): URLSearchParams {
  return new URLSearchParams(input);
}

export async function pullPeerCommons(input: {
  dial: PeerDial;
  route: PeerDialRoute;
  stewardVaultId: string;
  memberVaultId: string;
  grantId: string;
  seat: VaultDb;
  /** Owner consent: atomically join at the steward before first bootstrap. */
  acceptInvitation?: boolean;
  /** The metadata footprint the owner reviewed before accepting. */
  expectedSizeBytes?: number;
  now?: string;
}): Promise<
  | { state: "current"; sequence: number }
  | { state: "noop"; sequence: number }
  | { state: "unavailable" }
> {
  try {
    if (input.acceptInvitation && input.expectedSizeBytes !== undefined) {
      const inspectParams = query(input);
      inspectParams.set("inspect", "1");
      const inspection = await input.dial.request({
        endpointTicket: endpoint(input.dial, input.route),
        method: "GET",
        target: `${PEER_COMMONS_BOOTSTRAP_PATH_PREFIX}${encodeURIComponent(
          input.grantId
        )}?${inspectParams}`,
      });
      const metadata = inspection.json as {
        state?: string;
        currentSizeBytes?: number;
        maxSizeBytes?: number | null;
      };
      if (
        inspection.status !== 200 ||
        metadata.state !== "metadata" ||
        typeof metadata.currentSizeBytes !== "number"
      )
        return { state: "unavailable" };
      if (
        metadata.currentSizeBytes !== input.expectedSizeBytes ||
        (typeof metadata.maxSizeBytes === "number" &&
          metadata.currentSizeBytes > metadata.maxSizeBytes)
      ) {
        input.seat.vault
          .prepare(
            `UPDATE share_commons_invitation
                SET current_size_bytes = ?, max_size_bytes = ?
              WHERE grant_id = ? AND member_vault_id = ? AND status = 'pending'`
          )
          .run(
            metadata.currentSizeBytes,
            metadata.maxSizeBytes ?? null,
            input.grantId,
            input.memberVaultId
          );
        return { state: "unavailable" };
      }
    }
    const params = query(input);
    if (input.acceptInvitation) params.set("accept", "1");
    const cursor = readCommonsCursor(
      input.seat.vault,
      input.grantId,
      input.memberVaultId
    );
    if (cursor) params.set("afterSequence", String(cursor.sequence));
    const response = await input.dial.request({
      endpointTicket: endpoint(input.dial, input.route),
      method: "GET",
      target: `${PEER_COMMONS_BOOTSTRAP_PATH_PREFIX}${encodeURIComponent(
        input.grantId
      )}?${params}`,
    });
    const body = response.json as {
      state?: string;
      wire?: CommonsBootstrap;
      tombstone?: CommonsTombstone;
      currentSequence?: number;
    };
    if (
      response.status === 200 &&
      body.state === "tombstone" &&
      body.tombstone
    ) {
      applyCommonsTombstone({ seat: input.seat, tombstone: body.tombstone });
      return { state: "current", sequence: body.tombstone.currentSequence };
    }
    // Already-current no-op: the steward acked our cursor and has nothing new.
    // Skip the destructive scrub+re-project entirely and report a non-progress
    // state so the sweep does not treat a caught-up pull as work done.
    if (
      response.status === 200 &&
      body.state === "current" &&
      typeof body.currentSequence === "number"
    )
      return { state: "noop", sequence: body.currentSequence };
    if (response.status !== 200 || body.state !== "bootstrap" || !body.wire)
      return { state: "unavailable" };
    for (const blob of body.wire.closure.blobs) {
      if (input.seat.blobs.local.hasSync(blob.sha256)) continue;
      const chunks: Buffer[] = [];
      let offset = 0;
      let total = Number.POSITIVE_INFINITY;
      while (offset < total) {
        const chunkQuery = query(input);
        chunkQuery.set("grantId", input.grantId);
        chunkQuery.set("sha256", blob.sha256);
        chunkQuery.set("offset", String(offset));
        chunkQuery.set("length", String(CHUNK_BYTES));
        // oxlint-disable-next-line no-await-in-loop -- each ranged request starts at the offset established by the preceding chunk
        const chunkResponse = await input.dial.request({
          endpointTicket: endpoint(input.dial, input.route),
          method: "GET",
          target: `${PEER_COMMONS_BLOB_PATH}?${chunkQuery}`,
        });
        const chunk = chunkResponse.json as {
          state?: string;
          offset?: number;
          totalSize?: number;
          bytes?: string;
        };
        if (
          chunkResponse.status !== 200 ||
          chunk.state !== "chunk" ||
          chunk.offset !== offset ||
          typeof chunk.totalSize !== "number" ||
          typeof chunk.bytes !== "string"
        )
          return { state: "unavailable" };
        const bytes = Buffer.from(chunk.bytes, "base64");
        chunks.push(bytes);
        offset += bytes.length;
        total = chunk.totalSize;
        if (bytes.length === 0 && offset < total)
          return { state: "unavailable" };
      }
      const bytes = Buffer.concat(chunks);
      if (createHash("sha256").update(bytes).digest("hex") !== blob.sha256)
        return { state: "unavailable" };
      input.seat.blobs.local.putSync(blob.sha256, bytes);
    }
    applyCommonsBootstrap({
      seat: input.seat,
      wire: body.wire,
      now: input.now ?? new Date().toISOString(),
    });
    return { state: "current", sequence: body.wire.currentSequence };
  } catch {
    return { state: "unavailable" };
  }
}

export async function sendPeerCommonsCommand(input: {
  dial: PeerDial;
  route: PeerDialRoute;
  stewardVaultId: string;
  memberVaultId: string;
  grantId: string;
  actorPartyId: string;
  command: string;
  commandInput: Record<string, unknown>;
  memberSignature: CommonsMemberSignature;
  intentId: string;
}): Promise<
  | { state: "executed"; sequence: number }
  | { state: "refused"; reason?: string }
  | { state: "unavailable" }
> {
  try {
    const response = await input.dial.request({
      endpointTicket: endpoint(input.dial, input.route),
      method: "POST",
      target: PEER_COMMONS_COMMAND_PATH,
      body: {
        stewardVaultId: input.stewardVaultId,
        memberVaultId: input.memberVaultId,
        grantId: input.grantId,
        actorPartyId: input.actorPartyId,
        command: input.command,
        input: input.commandInput,
        memberSignature: input.memberSignature,
        intentId: input.intentId,
      },
    });
    const body = response.json as {
      state?: string;
      decision?: { sequence?: number; reason?: string };
    };
    if (
      body.state === "executed" &&
      typeof body.decision?.sequence === "number"
    )
      return { state: "executed", sequence: body.decision.sequence };
    if (body.state === "refused")
      return {
        state: "refused",
        ...(body.decision?.reason ? { reason: body.decision.reason } : {}),
      };
    return { state: "unavailable" };
  } catch {
    return { state: "unavailable" };
  }
}

export async function invitePeerToCommons(input: {
  dial: PeerDial;
  route: PeerDialRoute;
  wire?: CommonsBootstrap;
  invitation?: Omit<
    CommonsInvitationRecord,
    "invitationId" | "status" | "createdAt" | "answeredAt"
  >;
}): Promise<boolean> {
  try {
    let invitation = input.invitation;
    if (!invitation && input.wire) {
      const binding = input.wire.control.bindings.find(
        (entry) => entry["vault_id"] === input.wire!.memberVaultId
      );
      const memberPartyId =
        typeof binding?.["party_id"] === "string"
          ? binding["party_id"]
          : undefined;
      const member = input.wire.control.members.find(
        (entry) => entry["party_id"] === memberPartyId
      );
      const grant = input.wire.control.grant;
      if (
        !memberPartyId ||
        (member?.["capability"] !== "read" &&
          member?.["capability"] !== "read+write")
      )
        return false;
      invitation = {
        grantId: input.wire.grantId,
        stewardVaultId: input.wire.stewardVaultId,
        memberVaultId: input.wire.memberVaultId,
        memberPartyId,
        capability: member["capability"],
        containerType: String(grant["container_type"]),
        containerId: String(grant["container_id"]),
        ...(typeof input.wire.control.circle["name"] === "string"
          ? { containerLabel: input.wire.control.circle["name"] }
          : {}),
        currentSizeBytes: commonsClosureSizeBytes(input.wire.closure),
        ...(typeof grant["max_size_bytes"] === "number"
          ? { maxSizeBytes: grant["max_size_bytes"] }
          : {}),
      };
    }
    if (!invitation) return false;
    const response = await input.dial.request({
      endpointTicket: endpoint(input.dial, input.route),
      method: "POST",
      target: PEER_COMMONS_INVITE_PATH,
      body: {
        invitation,
      },
    });
    return (
      response.status === 200 &&
      (response.json as { state?: string }).state === "pending"
    );
  } catch {
    return false;
  }
}

export async function claimPeerCommonsInvitation(input: {
  dial: PeerDial;
  route: PeerDialRoute;
  stewardVaultId: string;
  memberVaultId: string;
  claimToken: string;
  seat: VaultDb;
  now?: string;
}): Promise<boolean> {
  try {
    const response = await input.dial.request({
      endpointTicket: endpoint(input.dial, input.route),
      method: "POST",
      target: PEER_COMMONS_CLAIM_PATH,
      body: {
        stewardVaultId: input.stewardVaultId,
        memberVaultId: input.memberVaultId,
        claimToken: input.claimToken,
      },
    });
    const invitation = (
      response.json as {
        state?: string;
        invitation?: CommonsInvitationRecord;
      }
    ).invitation;
    if (
      response.status !== 200 ||
      !invitation ||
      invitation.memberVaultId !== input.memberVaultId
    )
      return false;
    queueCommonsInvitation({
      seat: input.seat.vault,
      invitation: {
        ...invitation,
        memberVaultId: input.memberVaultId,
      },
      now: input.now ?? new Date().toISOString(),
    });
    return true;
  } catch {
    return false;
  }
}

export async function refusePeerCommonsInvitation(input: {
  dial: PeerDial;
  route: PeerDialRoute;
  stewardVaultId: string;
  memberVaultId: string;
  grantId: string;
}): Promise<boolean> {
  try {
    const response = await input.dial.request({
      endpointTicket: endpoint(input.dial, input.route),
      method: "POST",
      target: PEER_COMMONS_REFUSE_PATH,
      body: {
        stewardVaultId: input.stewardVaultId,
        memberVaultId: input.memberVaultId,
        grantId: input.grantId,
      },
    });
    return (
      response.status === 200 &&
      (response.json as { state?: string }).state === "refused"
    );
  } catch {
    return false;
  }
}
