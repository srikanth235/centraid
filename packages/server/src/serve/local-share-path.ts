/*
 * TWO VAULTS ON ONE GATEWAY TAKE THE LOCAL PATH (#1014, S2; ruling R-1014-10).
 *
 * A link between two vaults this host mounts carries `remoteVaultId: null` and
 * no `vault_routes` row: there is nothing to dial, and nothing for
 * `peerForVault` to answer with. The FORWARD half of delivery already knew
 * this — `loopbackShareTransports` places the closure straight into the
 * co-hosted seat — but the two halves the audience drives did not:
 *
 *   - the audience's PULL answered `unreachable`, so a seat that had missed a
 *     pass could never catch itself up; and
 *   - a member's EDIT of a projected row answered `retryable` forever, so an
 *     `edit` grant between two local vaults was a grant that could not be used.
 *
 * Both are served here, in process, through the SAME code the peer door runs
 * after its own admission: `composeShareTail` + `ingestShareTail` for the pull,
 * `executeMemberIntent` for the edit — receipt, durable intent row, parking
 * and answered versions included. What the local path drops is exactly the
 * remote half: no dial, and no vault signature, because a signature proves the
 * caller is the vault it claims to be and a caller inside this host already is
 * — this process opened both vaults. The GRANT is still what authorizes:
 * `admitGrantAtOrigin` refuses an unmounted origin, a revoked grant, and a
 * grant that does not reach this audience, exactly as the peer door does.
 */

import { shareShapeId } from "@centraid/core/protocol";
import {
  composeShareTail,
  placeBlob,
  readShareGrant,
  readSubscription,
} from "@centraid/vault";
import type {
  Credential,
  Gateway as VaultGateway,
  MemberIntentEnvelope,
  VaultDb,
} from "@centraid/vault";

import { executeMemberIntent } from "../routes/member-intent-exec.js";
import {
  admitGrantAtOrigin,
  ingestPulledTail,
} from "../routes/peer-replica-route.js";
import type { PeerReplicaPullOutcome } from "../routes/peer-replica-route.js";
import type {
  ProjectedEditAnswer,
  ProjectedEditRequest,
} from "./projected-edit.js";

export interface LocalShareHost {
  vaultFor: (vaultId: string) => VaultDb | undefined;
  gatewayFor: (vaultId: string) => VaultGateway | undefined;
  credentialFor: (vaultId: string) => Credential | undefined;
  /** How this host names a vault, for a parked command's `waitingOn`. */
  labelFor?: (vaultId: string) => string | undefined;
  now: () => string;
}

/**
 * The audience's pull, served from the origin's own handle. `undefined` means
 * this is NOT a same-gateway pair, so the caller falls through to the peer
 * path — never an `unreachable`, which would claim a fact about reach that
 * this function is not the one to state.
 */
export function pullShareTailLocally(
  host: LocalShareHost,
  input: {
    originVaultId: string;
    audienceVaultId: string;
    shapeId: string;
    seat: VaultDb;
  }
): PeerReplicaPullOutcome | undefined {
  const admission = admitGrantAtOrigin(host.vaultFor, input);
  if (!admission) return undefined;
  const grant = readShareGrant(admission.origin.vault, admission.grantId);
  if (!grant) return undefined;
  // Where the SEAT is, asked of the seat: the origin's own record is what a
  // resend exists to distrust.
  const standing = readSubscription(
    input.seat.vault,
    admission.grantId,
    input.audienceVaultId
  );
  const since =
    standing === undefined || standing.cursor.epoch === null
      ? undefined
      : { epoch: standing.cursor.epoch, seq: standing.cursor.seq };
  const pass = composeShareTail({
    origin: admission.origin.vault,
    originVaultId: input.originVaultId,
    audienceVaultId: input.audienceVaultId,
    authorityId: admission.grantId,
    subjectType: grant.subjectType,
    subjectId: grant.subjectId,
    maxSizeBytes: grant.maxSizeBytes,
    ...(since === undefined ? {} : { since }),
  });
  if (!pass)
    return {
      state: "unreachable",
      detail: "this grant's closure cannot be served as rows",
    };
  // ONE HOST, ONE FILESYSTEM: the bytes are placed rather than chunked over a
  // wire that is not there. Idempotent, and the origin is never written, so
  // there is no two-database transaction here either.
  for (const blob of pass.frame.blobs)
    placeBlob(
      admission.origin.blobs.local,
      input.seat.blobs.local,
      blob.sha256
    );
  const outcome = ingestPulledTail(input.seat, pass.frame, {
    audienceVaultId: input.audienceVaultId,
    now: host.now(),
  });
  // Settled only once the audience holds the rows, exactly as the peer door
  // settles after it has served them.
  pass.settle();
  return outcome;
}

/**
 * A member's edit of a projected row, forwarded into the origin's intent door
 * in process. `undefined` when the pair is not same-gateway.
 */
export function forwardProjectedEditLocally(
  host: LocalShareHost,
  request: ProjectedEditRequest
): ProjectedEditAnswer | undefined {
  const shapeId = shareShapeId(request.route.authorityId);
  const admission = admitGrantAtOrigin(host.vaultFor, {
    originVaultId: request.route.originVaultId,
    audienceVaultId: request.audienceVaultId,
    shapeId,
  });
  if (!admission) return undefined;
  // The row ids the envelope names are the ORIGIN'S, translated out of
  // lineage — the same envelope `forwardOverPeer` builds, minus the signature.
  const envelope: MemberIntentEnvelope = {
    intentId: request.intentId,
    shapeId,
    originVaultId: request.route.originVaultId,
    memberVaultId: request.audienceVaultId,
    appId: request.appId,
    action: request.action,
    input: request.input,
    // NO BASE VERSION FROM LINEAGE (#1014, V7). `origin_row_version` is
    // documented as, and written as, the ORIGIN'S REPLICA CHANGE SEQUENCE —
    // `applyShareOutputs` stores `outputs.cursor.seq` and `projectShareClosure`
    // stores `grant.rowVersions` (a log position, `?? 0`). Sending it as a base
    // version would compare a transport position against `row_version` in
    // `originConflict`: 432 against 2, refusing every member edit. It was never
    // read before this slice, so stating nothing is what it always meant.
    //
    // WHAT ARMS THIS: the lineage carrying the origin's own `row_version` for
    // the row. The number is already in the share row image and is stripped as
    // a LOCAL column by `apply-outputs.ts#LOCAL_COLUMNS`; carrying it needs a
    // lineage column of its own (`origin_row_version` cannot be repurposed —
    // `subscription-seat.ts` compares the pending-drop against it as a log
    // position). Until then the origin's door checks whatever base versions an
    // envelope DOES state, and a member's forwarded edit states none.
  };
  const answer = executeMemberIntent(admission, envelope, {
    gatewayFor: host.gatewayFor,
    credentialFor: host.credentialFor,
    memberLabel: host.labelFor?.(request.audienceVaultId),
    ownerLabel: host.labelFor?.(request.route.originVaultId),
  });
  return localAnswerOf(answer);
}

/** The origin's answer, in the shape the seat settles against. */
function localAnswerOf(answer: {
  status: number;
  body: Record<string, unknown>;
}): ProjectedEditAnswer {
  const state = answer.body.state;
  const reason =
    typeof answer.body.reason === "string" ? answer.body.reason : undefined;
  const commitSeq =
    typeof answer.body.commitSeq === "number"
      ? answer.body.commitSeq
      : undefined;
  if (state === "executed")
    return {
      status: "executed",
      ...(commitSeq === undefined ? {} : { commitSeq }),
    };
  if (state === "parked")
    return { status: "parked", ...(reason === undefined ? {} : { reason }) };
  if (state === "denied" || state === "refused")
    return {
      status: "denied",
      reason: reason ?? "the origin refused it",
    };
  // `not_found` from the exec means the origin is no longer mounted or has no
  // credential — a fact about REACH, so the intent stays retryable.
  return {
    status: "retryable",
    reason: reason ?? "the origin could not be reached on this host",
  };
}
