/** Dialing half of Commons peer sync and signed member-command delivery. */

import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, rmSync, writeSync } from "node:fs";

import {
  applyCommonsBootstrap,
  applyCommonsTombstone,
  commonsClosureSizeBytes,
  isCommonsHistoryError,
  queueCommonsInvitation,
  readCommonsCursor,
  readCommonsVerified,
} from "@centraid/vault";
import type {
  CommonsBootstrap,
  CommonsHistoryFaultTag,
  CommonsInvitationRecord,
  CommonsMemberSignature,
  Credential,
  Gateway as VaultGateway,
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
import {
  recordCommonsDeviceReach,
  recordCommonsPull,
} from "./commons-observability.js";
import type {
  CommonsPullOutcome,
  CommonsStewardStatus,
} from "./commons-observability.js";
import { collectCommonsBootstrapPages } from "./peer-commons-pages-client.js";
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

export interface PullPeerCommonsInput {
  dial: PeerDial;
  route: PeerDialRoute;
  stewardVaultId: string;
  memberVaultId: string;
  grantId: string;
  seat: VaultDb;
  /** Mounted production executor for incremental command tails. */
  gateway?: VaultGateway;
  credential?: Credential;
  /** Owner consent: atomically join at the steward before first bootstrap. */
  acceptInvitation?: boolean;
  /** The metadata footprint the owner reviewed before accepting. */
  expectedSizeBytes?: number;
  /** Test/metrics observer proving the live allocation stays at chunk scale. */
  onBlobChunk?: (bytes: number) => void;
  now?: string;
}

type PullAttempt =
  | {
      state: "current";
      sequence: number;
      /** Which shape the member had to accept — the fixed-window-sync signal. */
      kind: "tail" | "snapshot" | "tombstone";
    }
  | { state: "noop"; sequence: number }
  // A named history fault, distinct from a transport failure: the steward's
  // log diverged from what this seat verified, so the sweep must REPORT it
  // rather than retry-loop. The replica is untouched.
  | { state: "parked"; fault: CommonsHistoryFaultTag }
  | { state: "unavailable" };

export type PullPeerCommonsResult = (
  | { state: "current"; sequence: number }
  | { state: "noop"; sequence: number }
  | { state: "parked"; fault: CommonsHistoryFaultTag }
  | { state: "unavailable" }
) & {
  /**
   * The escalating steward-absence status this seat now holds for the grant
   * (#731). It rides on EVERY outcome, including `unavailable`, because the
   * whole point is that a member with a dead steward can render "Alice's
   * device hasn't been reachable for 9 days" instead of nothing.
   */
  steward: CommonsStewardStatus;
};

/**
 * One pull attempt, unaware of instrumentation. Every dial that RESOLVES —
 * whatever it answered — records this device's own link evidence, so a
 * genuinely offline device can never be mistaken for a dead steward.
 */
async function attemptPullPeerCommons(
  input: PullPeerCommonsInput,
  now: string
): Promise<PullAttempt> {
  const reached = async (target: {
    method: "GET" | "POST";
    target: string;
  }): ReturnType<PeerDial["request"]> => {
    const response = await input.dial.request({
      endpointTicket: endpoint(input.dial, input.route),
      ...target,
    });
    recordCommonsDeviceReach(input.seat.vault, now);
    return response;
  };
  try {
    if (input.acceptInvitation && input.expectedSizeBytes !== undefined) {
      const inspectParams = query(input);
      inspectParams.set("inspect", "1");
      const inspection = await reached({
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
    if (input.gateway && input.credential) params.set("incremental", "1");
    if (input.acceptInvitation) params.set("accept", "1");
    const cursor = readCommonsCursor(
      input.seat.vault,
      input.grantId,
      input.memberVaultId
    );
    if (cursor) params.set("afterSequence", String(cursor.sequence));
    const response = await reached({
      method: "GET",
      target: `${PEER_COMMONS_BOOTSTRAP_PATH_PREFIX}${encodeURIComponent(
        input.grantId
      )}?${params}`,
    });
    const body = await collectCommonsBootstrapPages({
      initial: response,
      next: async (frameId, pageCursor) => {
        const pageParams = new URLSearchParams(params);
        pageParams.delete("accept");
        pageParams.delete("afterSequence");
        pageParams.set("frameId", frameId);
        pageParams.set("pageCursor", String(pageCursor));
        return reached({
          method: "GET",
          target: `${PEER_COMMONS_BOOTSTRAP_PATH_PREFIX}${encodeURIComponent(
            input.grantId
          )}?${pageParams}`,
        });
      },
    });
    if (!body) return { state: "unavailable" };
    if (
      response.status === 200 &&
      body.state === "tombstone" &&
      body.tombstone
    ) {
      applyCommonsTombstone({ seat: input.seat, tombstone: body.tombstone });
      return {
        state: "current",
        sequence: body.tombstone.currentSequence,
        kind: "tombstone",
      };
    }
    // Already-current no-op: the steward acked our cursor and has nothing new.
    // Skip the destructive scrub+re-project entirely and report a non-progress
    // state so the sweep does not treat a caught-up pull as work done.
    if (
      response.status === 200 &&
      body.state === "current" &&
      typeof body.currentSequence === "number"
    ) {
      // "Caught up" is only true if the steward's head is the head we verified
      // (#731). A fork at an already-verified sequence hides here otherwise.
      const verified = readCommonsVerified(input.seat.vault, input.grantId);
      if (
        verified?.sequence === body.currentSequence &&
        verified.opHash !== body.headHash
      )
        return { state: "parked", fault: "history-diverged" };
      return { state: "noop", sequence: body.currentSequence };
    }
    if (response.status !== 200 || body.state !== "bootstrap" || !body.wire)
      return { state: "unavailable" };
    for (const blob of body.wire.closure.blobs) {
      if (input.seat.blobs.local.hasSync(blob.sha256)) continue;
      if (
        !input.seat.blobs.local.promotionTempPathSync ||
        !input.seat.blobs.local.adoptTempSync
      )
        throw new Error("commons CAS does not support bounded stream adoption");
      const tempPath = input.seat.blobs.local.promotionTempPathSync(
        blob.sha256
      );
      const tempFile = openSync(tempPath, "wx");
      const digest = createHash("sha256");
      let offset = 0;
      let total = Number.POSITIVE_INFINITY;
      try {
        while (offset < total) {
          const chunkQuery = query(input);
          chunkQuery.set("grantId", input.grantId);
          chunkQuery.set("sha256", blob.sha256);
          chunkQuery.set("offset", String(offset));
          chunkQuery.set("length", String(CHUNK_BYTES));
          // oxlint-disable-next-line no-await-in-loop -- each ranged request starts at the offset established by the preceding chunk
          const chunkResponse = await reached({
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
            chunk.totalSize !== blob.size ||
            typeof chunk.bytes !== "string"
          )
            throw new Error("commons blob chunk is invalid");
          const bytes = Buffer.from(chunk.bytes, "base64");
          input.onBlobChunk?.(bytes.length);
          digest.update(bytes);
          writeSync(tempFile, bytes);
          offset += bytes.length;
          total = chunk.totalSize;
          if (bytes.length === 0 && offset < total)
            throw new Error("commons blob chunk made no progress");
        }
        if (digest.digest("hex") !== blob.sha256)
          throw new Error("commons blob failed content verification");
        fsyncSync(tempFile);
        closeSync(tempFile);
        input.seat.blobs.local.adoptTempSync(blob.sha256, tempPath);
      } catch (error) {
        try {
          closeSync(tempFile);
        } catch {
          // The successful adoption path already closed the descriptor.
        }
        rmSync(tempPath, { force: true });
        throw error;
      }
    }
    applyCommonsBootstrap({
      seat: input.seat,
      wire: body.wire,
      now,
      ...(input.gateway && input.credential
        ? {
            applyCommand: (
              command: string,
              commandInput: Record<string, unknown>,
              invocationId: string
            ) =>
              input.gateway!.invokeCommonsCanonical(
                input.credential!,
                {
                  command,
                  input: commandInput,
                  purpose: "dpv:ServiceProvision",
                  invocationId,
                },
                { idSeed: invocationId }
              ),
          }
        : {}),
    });
    return {
      state: "current",
      sequence: body.wire.currentSequence,
      // A frame whose snapshot already sits past what this seat had applied
      // forced a full re-baseline; anything else was appliable as a tail. That
      // split is the fixed-window-sync plan's laggard signal.
      kind:
        (cursor?.sequence ?? 0) >= body.wire.snapshotSequence
          ? "tail"
          : "snapshot",
    };
  } catch (error) {
    if (isCommonsHistoryError(error))
      return { state: "parked", fault: error.fault };
    return { state: "unavailable" };
  }
}

function outcomeOf(attempt: PullAttempt): CommonsPullOutcome {
  if (attempt.state === "current") return attempt.kind;
  if (attempt.state === "noop") return "noop";
  if (attempt.state === "parked") return "parked";
  return "unreachable";
}

/**
 * Pull this member seat forward, and fold the attempt into the durable
 * steward-contact record so the result can say WHY nothing moved. The status
 * is derived from elapsed silence plus this device's own link evidence, so an
 * unreachable steward and an unreachable device are never the same answer.
 */
export async function pullPeerCommons(
  input: PullPeerCommonsInput
): Promise<PullPeerCommonsResult> {
  const now = input.now ?? new Date().toISOString();
  const attempt = await attemptPullPeerCommons(input, now);
  const steward = recordCommonsPull({
    db: input.seat.vault,
    grantId: input.grantId,
    memberVaultId: input.memberVaultId,
    stewardVaultId: input.stewardVaultId,
    outcome: outcomeOf(attempt),
    ...(attempt.state === "parked" ? { fault: attempt.fault } : {}),
    ...(attempt.state === "unavailable"
      ? { error: "steward unreachable" }
      : {}),
    now,
  });
  if (attempt.state === "current")
    return { state: "current", sequence: attempt.sequence, steward };
  if (attempt.state === "noop")
    return { state: "noop", sequence: attempt.sequence, steward };
  if (attempt.state === "parked")
    return { state: "parked", fault: attempt.fault, steward };
  return { state: "unavailable", steward };
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
  /** The grant sequence the member had projected locally when it composed
   * this command (issue #731 goal 1). Required on the wire in v0 — a remote
   * intent must be classified on the same basis as a local one, so there is
   * no defaulting/compat branch for an omitted value; see
   * `handlePeerCommonsCommand` for the receiving side's hard refusal. */
  basedOnSequence: number;
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
        basedOnSequence: input.basedOnSequence,
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
