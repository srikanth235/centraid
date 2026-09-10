/*
 * WHAT THE ORIGIN DOES WITH A MEMBER'S WRITE (#929, #1014 R-1014-10).
 *
 * Split out of `peer-replica-intent-route.ts` so the two ways an edit can
 * arrive share ONE implementation. The peer door proves a remote member's
 * signature and calls this; a same-gateway edit — two vaults on one host,
 * `remoteVaultId: null`, nothing to dial — calls this directly, because the
 * caller is already inside the host that owns both vaults. Everything after
 * admission and attribution is identical, and it has to be: the receipt, the
 * durable intent row, the confirmation parking and the answered versions are
 * what the member's seat settles against, and a second copy of them would
 * drift.
 *
 * The answer is an HTTP status and a body because that is what the member's
 * seat reads on both paths; the local caller reads the same shape rather than
 * a private one.
 */

import crypto from "node:crypto";

import {
  currentReplicaLogState,
  judgeMemberIntent,
  partiesBoundToVault,
  readReplicaIntentOutcome,
  recordReplicaIntentOutcome,
  writeReceipt,
} from "@centraid/vault";
import type {
  Credential,
  Gateway as VaultGateway,
  MemberIntentEnvelope,
} from "@centraid/vault";

import type { Admission } from "./peer-replica-route.js";

export interface MemberIntentAnswer {
  status: number;
  body: Record<string, unknown>;
}

export interface MemberIntentExecDeps {
  gatewayFor: (vaultId: string) => VaultGateway | undefined;
  credentialFor: (vaultId: string) => Credential | undefined;
  /** How the ORIGIN names the member — the link's label, or the vault id. */
  memberLabel?: string | undefined;
  /** How the member should name whoever a parked command waits on. */
  ownerLabel?: string | undefined;
}

/**
 * ORIGIN side: execute a member's write as the single writer of the container.
 *
 * The member never writes into their own copy and hopes it converges. What
 * arrives is an intent; what the origin does is execute it under its OWN
 * credential and write a receipt that names the member, because the person who
 * composed the change and the credential that carried it are different facts.
 *
 * A confirmation-gated command PARKS, and the answer says who it waits on.
 */
export function executeMemberIntent(
  admission: Admission,
  envelope: MemberIntentEnvelope,
  deps: MemberIntentExecDeps
): MemberIntentAnswer {
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
    return {
      status: 200,
      body: {
        state: "denied",
        intentId: envelope.intentId,
        reason: verdict.reason,
      },
    };
  const gateway = deps.gatewayFor(envelope.originVaultId);
  const credential = deps.credentialFor(envelope.originVaultId);
  if (!gateway || !credential)
    return { status: 404, body: { state: "not_found" } };
  const memberLabel = deps.memberLabel ?? envelope.memberVaultId;
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
    return {
      status: 409,
      body: {
        state: "refused",
        intentId: envelope.intentId,
        reason:
          "this intent id was admitted with a different payload; mint a new id for a changed operation",
      },
    };
  if (retained?.status === "executed")
    return {
      status: 200,
      body: {
        state: "executed",
        intentId: envelope.intentId,
        ...(retained.commitSeq === undefined
          ? {}
          : { commitSeq: retained.commitSeq }),
        ...(retained.produced === undefined
          ? {}
          : { produced: retained.produced.map((row) => ({ ...row })) }),
        answeredVersions: answeredVersionsFor(admission, verdict.route),
      },
    };
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
    return {
      status: 202,
      body: { state: "parked", intentId: envelope.intentId },
    };
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
  const settle = (
    status: "executed" | "denied" | "parked",
    reason?: string
  ): void => {
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
    } catch {
      // The answer the member gets is the invoke's; a failed settle leaves the
      // `sending` row, which is exactly what a retry consumes.
    }
  };
  if (result.status === "parked") {
    settle("parked", "reason" in result ? result.reason : undefined);
    return {
      status: 202,
      body: {
        state: "parked",
        intentId: envelope.intentId,
        reason: "reason" in result ? result.reason : undefined,
        waitingOn: { seat: "owner", label: deps.ownerLabel ?? undefined },
      },
    };
  }
  if (result.status !== "executed") {
    const reason =
      "reason" in result && result.reason
        ? result.reason
        : "the origin refused it";
    settle("denied", reason);
    return {
      status: 200,
      body: { state: "denied", intentId: envelope.intentId, reason },
    };
  }
  settle("executed");
  // Read back rather than trust the invoke: `commit_seq` and the produced set
  // were stamped INSIDE the canonical transaction (`gateway/execution.ts`),
  // which is the only place that knows them.
  const settled = readReplicaIntentOutcome(
    admission.origin.vault,
    envelope.intentId,
    memberDeviceId
  );
  return {
    status: 200,
    body: {
      state: "executed",
      intentId: envelope.intentId,
      ...(settled?.commitSeq === undefined
        ? {}
        : { commitSeq: settled.commitSeq }),
      ...(settled?.produced === undefined
        ? {}
        : { produced: settled.produced.map((row) => ({ ...row })) }),
      // G1: the ORIGIN versions this answer stands for. The member's seat
      // drops its pending row only once its lineage carries them.
      answeredVersions: answeredVersionsFor(admission, verdict.route),
    },
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
