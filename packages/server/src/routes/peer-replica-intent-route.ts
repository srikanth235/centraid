/*
 * THE MEMBER WRITE DOOR (#929). A member with an `edit` grant sends a SIGNED
 * intent; the ORIGIN executes it as the single writer of the container. Kept
 * beside `peer-replica-route.ts` rather than inside it: admission is that
 * module's contract, and this one is what happens after it.
 */

import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  currentReplicaLogState,
  judgeMemberIntent,
  partiesBoundToVault,
  readReplicaIntentOutcome,
  recordReplicaIntentOutcome,
  verifyMemberIntent,
  writeReceipt,
} from "@centraid/vault";
import type {
  MemberIntentEnvelope,
  ReplicaIntentOutcome,
} from "@centraid/vault";

import type { PeerIdentity } from "./peer-plane.js";
import { admitAtOrigin } from "./peer-replica-route.js";
import type { Admission, PeerReplicaDeps } from "./peer-replica-route.js";
import { readJson, sendJson } from "./route-helpers.js";

function notFound(res: ServerResponse): true {
  return sendJson(res, 404, { state: "not_found" });
}

/**
 * ORIGIN door: a member's SIGNED write (#929).
 *
 * The origin is the single writer of the container, so the member never writes
 * into their own copy and hopes it converges. What arrives is an intent; what
 * the origin does is execute it under its OWN credential and write a receipt
 * that names the member, because the person who composed the change and the
 * credential that carried it are different facts.
 *
 * A confirmation-gated command PARKS, and the answer says who it waits on with
 * the label from the link — so the member reads a person, not a vault id.
 */
export async function handlePeerReplicaIntent(
  req: IncomingMessage,
  res: ServerResponse,
  peer: PeerIdentity,
  deps: PeerReplicaDeps
): Promise<true> {
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { state: "bad_request" });
  }
  const envelope = readEnvelope(body);
  if (!envelope) return sendJson(res, 400, { state: "bad_request" });
  const params = new URLSearchParams({
    originVaultId: envelope.originVaultId,
    audienceVaultId: envelope.memberVaultId,
    shapeId: envelope.shapeId,
  });
  const admission = admitAtOrigin(peer, params, deps);
  if (!admission) return notFound(res);
  const link = peer.linkForPair(envelope.originVaultId, envelope.memberVaultId);
  const signature = typeof body.signature === "string" ? body.signature : "";
  // ATTRIBUTION, not admission: the link already admitted the request, and
  // this proves WHICH vault composed it. A bad signature is a refusal with a
  // reason, never a 404 — the peer is linked and needs to know what to fix.
  if (!link || !verifyMemberIntent(envelope, link.peerPublicKey, signature))
    return sendJson(res, 403, {
      state: "refused",
      reason: "the member's vault signature does not verify",
    });
  const memberPartyIds = partiesBoundToVault(
    admission.origin.vault,
    envelope.memberVaultId
  );
  const verdict = judgeMemberIntent(admission.origin, {
    action: envelope.action,
    commandInput: (envelope.input ?? {}) as Record<string, unknown>,
    memberPartyIds,
  });
  if (verdict.state === "refused")
    return sendJson(res, 200, {
      state: "denied",
      intentId: envelope.intentId,
      reason: verdict.reason,
    });
  const gateway = deps.gatewayFor?.(envelope.originVaultId);
  const credential = deps.credentialFor?.(envelope.originVaultId);
  if (!gateway || !credential) return notFound(res);
  const memberLabel = link.peerLabel ?? envelope.memberVaultId;
  // THE PEER PATH IS DURABLE TOO (#996, R24). A member's write used to be
  // answered from the invoke result and forgotten: a lost acknowledgement had
  // nothing to replay against, so a retry re-executed. The device path has
  // always recorded before dispatching; this records the same way, keyed on
  // the MEMBER'S VAULT as the device — that is the identity the envelope was
  // signed by, and the one a retry will arrive under. The row exists before
  // `invoke` so `execution.ts` has something to stamp `commit_seq` and the
  // produced set onto, inside the canonical transaction.
  const memberDeviceId = `peer:${envelope.memberVaultId}`;
  const payloadHash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        action: envelope.action,
        appId: envelope.appId,
        input: envelope.input ?? {},
      })
    )
    .digest("hex");
  const retained = readReplicaIntentOutcome(
    admission.origin.vault,
    envelope.intentId,
    memberDeviceId
  );
  if (retained && retained.payloadHash !== payloadHash)
    return sendJson(res, 409, {
      state: "refused",
      intentId: envelope.intentId,
      reason:
        "this intent id was admitted with a different payload; mint a new id for a changed operation",
    });
  const dedupe = retainedPeerAnswer(retained, link.myLabel ?? undefined);
  if (dedupe)
    return sendJson(res, dedupe.status, {
      ...dedupe.body,
      ...(dedupe.body.state === "executed"
        ? { answeredVersions: answeredVersionsFor(admission, verdict.route) }
        : {}),
    });
  try {
    recordReplicaIntentOutcome(admission.origin.vault, {
      intentId: envelope.intentId,
      deviceId: memberDeviceId,
      appId: envelope.appId,
      action: envelope.action,
      payloadHash,
      status: "sending",
    });
  } catch {
    // An id another member already holds: the same non-oracle answer the
    // device door gives.
    return sendJson(res, 202, { state: "parked", intentId: envelope.intentId });
  }
  const result = gateway.invoke(credential, {
    command: envelope.action,
    input: (envelope.input ?? {}) as Record<string, unknown>,
    intentId: envelope.intentId,
    // The origin is the single WRITER, not the AUTHOR: a confirmation the
    // owner set over this command must fire, and the parked payload has to
    // carry who it is for.
    onBehalfOfMember: { vaultId: envelope.memberVaultId, label: memberLabel },
  });
  writeReceipt(admission.origin.audit, {
    authorityId: admission.grantId,
    invocationId: null,
    action: `act ${envelope.action}`,
    objectType: verdict.route.containerType,
    objectId: verdict.route.containerId,
    decision: result.status === "denied" ? "deny" : "allow",
    detail: {
      // THE MEMBER, not the credential that executed it.
      memberVaultId: envelope.memberVaultId,
      memberLabel,
      memberPartyIds,
      intentId: envelope.intentId,
      shapeId: envelope.shapeId,
      outcome: result.status,
    },
  });
  // A SETTLE THAT FAILED IS NOT AN ANSWER (#1014, V21). This used to swallow
  // the error and tell the member `executed` anyway, while the row stayed
  // `sending` — so the member's seat cleared its overlay against a verdict the
  // origin has no record of, and the next retry re-executed the write. One
  // retry (the failure is usually a busy writer), then the truth: the caller
  // is told `in-flight` and re-polls, and the origin's own audit band carries
  // the intent id so an owner can see what did not get written down.
  const settle = (
    status: "executed" | "denied" | "parked",
    reason?: string
  ): boolean => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        recordReplicaIntentOutcome(admission.origin.vault, {
          intentId: envelope.intentId,
          deviceId: memberDeviceId,
          appId: envelope.appId,
          action: envelope.action,
          payloadHash,
          status,
          ...(reason === undefined ? {} : { reason }),
        });
        return true;
      } catch (error) {
        if (attempt === 1)
          recordSettleFailure(admission, envelope, status, error);
      }
    }
    return false;
  };
  if (result.status === "parked") {
    settle("parked", "reason" in result ? result.reason : undefined);
    return sendJson(res, 202, {
      state: "parked",
      intentId: envelope.intentId,
      reason: "reason" in result ? result.reason : undefined,
      waitingOn: { seat: "owner", label: link.myLabel ?? undefined },
    });
  }
  if (result.status !== "executed") {
    const reason =
      "reason" in result && result.reason
        ? result.reason
        : "the origin refused it";
    settle("denied", reason);
    return sendJson(res, 200, {
      state: "denied",
      intentId: envelope.intentId,
      reason,
    });
  }
  if (!settle("executed")) {
    // The write RAN; only its durable verdict did not. `in-flight` is the one
    // honest word for that: the caller re-polls, the retained `sending` row is
    // what the retry consumes, and nothing here claims a settlement the origin
    // cannot show.
    return sendJson(res, 202, {
      state: "in-flight",
      intentId: envelope.intentId,
      reason: "the origin executed this write but has not recorded its outcome",
    });
  }
  // Read back rather than trust the invoke: `commit_seq` and the produced set
  // were stamped INSIDE the canonical transaction (`gateway/execution.ts`),
  // which is the only place that knows them.
  const settled = readReplicaIntentOutcome(
    admission.origin.vault,
    envelope.intentId,
    memberDeviceId
  );
  return sendJson(res, 200, {
    state: "executed",
    intentId: envelope.intentId,
    ...(settled?.commitSeq === undefined
      ? {}
      : { commitSeq: settled.commitSeq }),
    ...(settled?.produced === undefined
      ? {}
      : { produced: settled.produced.map((row) => ({ ...row })) }),
    // G1: the ORIGIN versions this answer stands for. The member's seat drops
    // its pending row only once its lineage carries them.
    answeredVersions: answeredVersionsFor(admission, verdict.route),
  });
}

/**
 * EVERY RETAINED VERDICT IS A DEDUPE HIT, NOT JUST `executed` (#1014, V8).
 *
 * A retained `parked` row means the owner has ALREADY been asked and the
 * payload is already waiting for them. Re-invoking wrote a second parked
 * confirmation for the same intent, and approving both applied the write
 * twice. A retained `denied`, `failed` or `conflict` is equally settled — the
 * member's remedy is a new id against a fresh base, never another execution.
 *
 * `sending` is the one status that re-enters, because it means the row died
 * before its outcome; `undefined` is an id this member has never used.
 */
export function retainedPeerAnswer(
  retained: ReplicaIntentOutcome | undefined,
  ownerLabel: string | undefined
):
  | { status: number; body: Record<string, unknown> & { state: string } }
  | undefined {
  if (
    !retained ||
    retained.status === "sending" ||
    retained.status === "queued"
  )
    return undefined;
  if (retained.status === "executed")
    return {
      status: 200,
      body: {
        state: "executed",
        intentId: retained.intentId,
        ...(retained.commitSeq === undefined
          ? {}
          : { commitSeq: retained.commitSeq }),
        ...(retained.produced === undefined
          ? {}
          : { produced: retained.produced.map((row) => ({ ...row })) }),
      },
    };
  if (retained.status === "parked")
    return {
      status: 202,
      body: {
        state: "parked",
        intentId: retained.intentId,
        ...(retained.reason === undefined ? {} : { reason: retained.reason }),
        waitingOn: retained.waitingOn ?? { seat: "owner", label: ownerLabel },
      },
    };
  return {
    status: 200,
    body: {
      state: "denied",
      intentId: retained.intentId,
      reason: retained.reason ?? "the origin refused it",
    },
  };
}

/** The origin's own durable note that an answer was not written down (V21). */
function recordSettleFailure(
  admission: Admission,
  envelope: MemberIntentEnvelope,
  status: string,
  error: unknown
): void {
  try {
    writeReceipt(admission.origin.audit, {
      authorityId: admission.grantId,
      invocationId: null,
      action: "act replica.intent.settle",
      objectType: "replica.intent",
      objectId: envelope.intentId,
      decision: "deny",
      detail: {
        intentId: envelope.intentId,
        memberVaultId: envelope.memberVaultId,
        shapeId: envelope.shapeId,
        outcome: status,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  } catch {
    // The audit band is the LAST thing that can be written here; a failure to
    // write it must not turn a survivable outage into a 500 the member reads
    // as their write being lost.
  }
}

function readEnvelope(
  body: Record<string, unknown>
): MemberIntentEnvelope | undefined {
  const read = (key: string): string | undefined => {
    const value = body[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const intentId = read("intentId");
  const shapeId = read("shapeId");
  const originVaultId = read("originVaultId");
  const memberVaultId = read("memberVaultId");
  const appId = read("appId");
  const action = read("action");
  if (
    !intentId ||
    !shapeId ||
    !originVaultId ||
    !memberVaultId ||
    !appId ||
    !action ||
    !("input" in body)
  )
    return undefined;
  return {
    intentId,
    shapeId,
    originVaultId,
    memberVaultId,
    appId,
    action,
    input: body.input,
    ...(Array.isArray(body.baseVersions)
      ? {
          baseVersions:
            body.baseVersions as MemberIntentEnvelope["baseVersions"],
        }
      : {}),
  };
}

function answeredVersionsFor(
  admission: Admission,
  route: { containerType: string; containerId: string }
): { shapeId: string; entity: string; rowId: string; version: number }[] {
  const state = currentReplicaLogState(admission.origin.vault);
  const row = admission.origin.vault
    .prepare(
      `SELECT MAX(seq) AS seq FROM replica_change
        WHERE epoch = ? AND entity = ? AND row_id = ?`
    )
    .get(state.epoch, route.containerType, route.containerId) as {
    seq: number | null;
  };
  return row.seq === null
    ? []
    : [
        {
          shapeId: admission.shapeId,
          entity: route.containerType,
          rowId: route.containerId,
          version: row.seq,
        },
      ];
}
