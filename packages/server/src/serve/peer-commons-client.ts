// governance: allow-repo-hygiene file-size-limit (#750) the dialing half of Commons sync is one integrity boundary: frame fetch/pagination, transfer-session blob streaming, increment-vs-rebaseline fallback, and the signed command lane must agree on one wire vocabulary.
/** Dialing half of Commons peer sync and signed member-command delivery. */

import { createHash } from "node:crypto";
import { appendFileSync, createReadStream, rmSync, statSync } from "node:fs";

import {
  applyCommonsBootstrap,
  applyCommonsIncrement,
  applyCommonsTombstone,
  commonsClosureSizeBytes,
  isCommonsHistoryError,
  isCommonsIncrementUnusable,
  queueCommonsInvitation,
  readCommonsCursor,
  readCommonsVerified,
} from "@centraid/vault";
import type {
  CommonsBootstrap,
  CommonsHistoryFaultTag,
  CommonsIncrement,
  CommonsInvitationRecord,
  CommonsMemberSignature,
  CommonsTombstone,
  Credential,
  Gateway as VaultGateway,
  VaultDb,
} from "@centraid/vault";

import {
  PEER_COMMONS_BLOB_AUTH_PATH,
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
import type { PeerDial, PeerDialRoute } from "./peer-link-client.js";

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

type Reached = (target: {
  method: "GET" | "POST";
  target: string;
}) => ReturnType<PeerDial["request"]>;

function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

function fileSizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** One transfer session per pull (#750); stream into promotion temp, not whole-blob RAM. */
async function pullManifestBlobs(
  reached: Reached,
  input: {
    stewardVaultId: string;
    memberVaultId: string;
    grantId: string;
    seat: VaultDb;
  },
  blobs: readonly { sha256: string; size: number }[]
): Promise<boolean> {
  const store = input.seat.blobs.local;
  const missing = blobs.filter((blob) => !store.hasSync(blob.sha256));
  if (missing.length === 0) return true;
  const authQuery = query(input);
  authQuery.set("grantId", input.grantId);
  const auth = await reached({
    method: "GET",
    target: `${PEER_COMMONS_BLOB_AUTH_PATH}?${authQuery}`,
  });
  const opened = auth.json as { state?: string; token?: string };
  if (
    auth.status !== 200 ||
    opened.state !== "authorized" ||
    typeof opened.token !== "string"
  )
    return false;
  for (const blob of missing) {
    const tmpPath = store.promotionTempPathSync?.(blob.sha256);
    const chunks: Buffer[] = [];
    let offset = tmpPath ? fileSizeOf(tmpPath) : 0;
    let total = Number.POSITIVE_INFINITY;
    while (offset < total) {
      const chunkQuery = query(input);
      chunkQuery.set("grantId", input.grantId);
      chunkQuery.set("token", opened.token);
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
        typeof chunk.bytes !== "string"
      )
        return false;
      const bytes = Buffer.from(chunk.bytes, "base64");
      if (bytes.length === 0 && offset + bytes.length < chunk.totalSize)
        return false;
      if (tmpPath) appendFileSync(tmpPath, bytes);
      else chunks.push(bytes);
      offset += bytes.length;
      total = chunk.totalSize;
    }
    if (tmpPath) {
      // oxlint-disable-next-line no-await-in-loop -- verify-then-adopt must finish before the next blob reuses the hash state
      const digest = await sha256OfFile(tmpPath);
      if (
        digest !== blob.sha256 ||
        !store.adoptTempSync?.(blob.sha256, tmpPath)
      ) {
        rmSync(tmpPath, { force: true });
        return false;
      }
      continue;
    }
    const bytes = Buffer.concat(chunks);
    if (createHash("sha256").update(bytes).digest("hex") !== blob.sha256)
      return false;
    store.putSync(blob.sha256, bytes);
  }
  return true;
}

interface PullFrameBody {
  state?: string;
  wire?: CommonsBootstrap;
  increment?: CommonsIncrement;
  tombstone?: CommonsTombstone;
  currentSequence?: number;
  headHash?: string;
  session?: string;
  pages?: number;
}

/** Reassemble paginated frames (#750). */
async function fetchFrameBody(
  reached: Reached,
  input: {
    stewardVaultId: string;
    memberVaultId: string;
    grantId: string;
  },
  params: URLSearchParams
): Promise<PullFrameBody | undefined> {
  const response = await reached({
    method: "GET",
    target: `${PEER_COMMONS_BOOTSTRAP_PATH_PREFIX}${encodeURIComponent(
      input.grantId
    )}?${params}`,
  });
  if (response.status !== 200) return undefined;
  const body = response.json as PullFrameBody | undefined;
  if (!body || body.state !== "bootstrap-pages") return body;
  const session = body.session;
  const pages = body.pages;
  if (typeof session !== "string" || typeof pages !== "number")
    return undefined;
  let assembled = "";
  for (let page = 0; page < pages; page += 1) {
    const pageQuery = query(input);
    pageQuery.set("session", session);
    pageQuery.set("page", String(page));
    // oxlint-disable-next-line no-await-in-loop -- pages are ordered slices of one serialized frame
    const pageResponse = await reached({
      method: "GET",
      target: `${PEER_COMMONS_BOOTSTRAP_PATH_PREFIX}${encodeURIComponent(
        input.grantId
      )}?${pageQuery}`,
    });
    const slice = pageResponse.json as { state?: string; chunk?: string };
    if (
      pageResponse.status !== 200 ||
      slice.state !== "bootstrap-page" ||
      typeof slice.chunk !== "string"
    )
      return undefined;
    assembled += slice.chunk;
  }
  try {
    return JSON.parse(assembled) as PullFrameBody;
  } catch {
    return undefined;
  }
}

export interface PullPeerCommonsInput {
  dial: PeerDial;
  route: PeerDialRoute;
  stewardVaultId: string;
  memberVaultId: string;
  grantId: string;
  seat: VaultDb;
  acceptInvitation?: boolean;
  expectedSizeBytes?: number;
  /** Member page budget (#750); steward clamps to its ceiling. */
  pageBytes?: number;
  /** Replica executor for increment tails (#750.7); without it, full-frame catch-up. */
  gateway?: VaultGateway;
  credential?: Credential;
  now?: string;
}

type PullAttempt =
  | {
      state: "current";
      sequence: number;
      kind: "tail" | "snapshot" | "tombstone";
    }
  | { state: "noop"; sequence: number }
  // History fault, not transport: report, do not retry-loop; replica untouched.
  | { state: "parked"; fault: CommonsHistoryFaultTag }
  | { state: "unavailable" };

export type PullPeerCommonsResult = (
  | { state: "current"; sequence: number }
  | { state: "noop"; sequence: number }
  | { state: "parked"; fault: CommonsHistoryFaultTag }
  | { state: "unavailable" }
) & {
  /** Steward-absence status on every outcome, including `unavailable` (#731). */
  steward: CommonsStewardStatus;
};

/** Record this device's link evidence on every resolved dial. */
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
  // Canonical rail, host-only: replayed commands mint the steward's ids.
  const gateway = input.gateway;
  const credential = input.credential;
  const replicaExecutor =
    gateway && credential
      ? (
          command: string,
          commandInput: Record<string, unknown>,
          invocationId: string
        ) =>
          gateway.invokeCommonsCanonical(
            credential,
            {
              command,
              input: commandInput,
              invocationId,
            },
            { idSeed: invocationId }
          )
      : undefined;
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
    if (input.acceptInvitation) params.set("accept", "1");
    if (input.pageBytes !== undefined)
      params.set("pageBytes", String(input.pageBytes));
    const cursor = readCommonsCursor(
      input.seat.vault,
      input.grantId,
      input.memberVaultId
    );
    // Ack always travels. No replica executor → ask for the full frame.
    if (cursor) params.set("afterSequence", String(cursor.sequence));
    if (!replicaExecutor) params.set("full", "1");
    let body = await fetchFrameBody(reached, input, params);
    if (!body) return { state: "unavailable" };
    if (body.state === "tombstone" && body.tombstone) {
      applyCommonsTombstone({ seat: input.seat, tombstone: body.tombstone });
      return {
        state: "current",
        sequence: body.tombstone.currentSequence,
        kind: "tombstone",
      };
    }
    if (body.state === "current" && typeof body.currentSequence === "number") {
      // Caught up only if the steward's head is the head we verified (#731).
      const verified = readCommonsVerified(input.seat.vault, input.grantId);
      if (
        verified?.sequence === body.currentSequence &&
        verified.opHash !== body.headHash
      )
        return { state: "parked", fault: "history-diverged" };
      return { state: "noop", sequence: body.currentSequence };
    }
    // Increment (#750.7): replay missed ops; unusable tail falls back to full frame.
    if (body.state === "increment" && body.increment && replicaExecutor) {
      const increment = body.increment;
      if (!(await pullManifestBlobs(reached, input, increment.blobs)))
        return { state: "unavailable" };
      try {
        applyCommonsIncrement({
          seat: input.seat,
          increment,
          now,
          applyCommand: replicaExecutor,
        });
        return {
          state: "current",
          sequence: increment.currentSequence,
          kind: "tail",
        };
      } catch (error) {
        if (!isCommonsIncrementUnusable(error)) throw error;
        const fullParams = query(input);
        if (cursor) fullParams.set("afterSequence", String(cursor.sequence));
        fullParams.set("full", "1");
        if (input.pageBytes !== undefined)
          fullParams.set("pageBytes", String(input.pageBytes));
        body = await fetchFrameBody(reached, input, fullParams);
        if (!body) return { state: "unavailable" };
      }
    }
    if (body.state !== "bootstrap" || !body.wire)
      return { state: "unavailable" };
    const wire = body.wire;
    if (!(await pullManifestBlobs(reached, input, wire.closure.blobs)))
      return { state: "unavailable" };
    applyCommonsBootstrap({ seat: input.seat, wire, now });
    return {
      state: "current",
      sequence: wire.currentSequence,
      kind:
        (cursor?.sequence ?? 0) >= wire.snapshotSequence ? "tail" : "snapshot",
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

/** Pull this seat forward; steward vs device unreachability are distinct. */
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
  /** Required on the wire; no omitted-value compat (#731). */
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
