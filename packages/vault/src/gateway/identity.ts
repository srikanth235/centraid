// S1 — Identity: every caller authenticates as an enrolled row. An unknown
// caller is dropped at transport, with no grantee to receipt against, so
// nothing enters the model — not even a denial row.

import type { DatabaseSync } from "node:sqlite";

import type { Credential, Identity } from "./types.js";
import { GatewayError } from "./types.js";

interface AgentRow {
  agent_id: string;
  party_id: string;
  status: string;
  /** NULL when the private sibling is absent — a seat's copy, never the gateway's. */
  enrollment_key: string | null;
}

/** The assistant's enrolment key; the one agent with no standing answer (#928 A3). */
const ASSISTANT_ENROLLMENT_KEY = "_assistant";
interface DeviceIdentityRow {
  device_id: string;
  owner_party_id: string;
  /** NULL when the private sibling is absent — a seat's copy, never the gateway's. */
  public_key: string | null;
}

/*
 * ENROLLMENT IS FULL TRUST (#996, R11). This read used to join a second fact —
 * a `share_authority` row, principal kind 'device' — because a device could be
 * answered about: full, readonly, or revoked. It cannot any more. A seat holds
 * this vault or it does not, and the fact that says so is the KEY: an enrolled
 * device has a row in `access_device_secret` whose public key matches, and
 * revoking one deletes that row. Unknown and revoked are the same refusal
 * because they are now the same fact.
 */
const DEVICE_IDENTITY_SQL = `SELECT access_device.device_id AS device_id,
    owner_party_id, access_device_secret.public_key AS public_key
  FROM access_device
  LEFT JOIN access_device_secret
    ON access_device_secret.device_id = access_device.device_id
  WHERE access_device.device_id = ?`;

function deviceRow(
  vault: DatabaseSync,
  deviceId: string,
  deviceKey: string
): DeviceIdentityRow {
  const row = vault.prepare(DEVICE_IDENTITY_SQL).get(deviceId) as
    | DeviceIdentityRow
    | undefined;
  if (!row || row.public_key !== deviceKey) {
    throw new GatewayError("identity", "unknown caller");
  }
  return row;
}

/** v0 key-equality; real request signatures change only this function. */
export function authenticate(vault: DatabaseSync, cred: Credential): Identity {
  if (cred.kind === "agent") {
    // An autonomous agent principal rides an enrolled device's key. The call
    // is the CHECK — it throws on a seat this vault does not know — and the
    // row it returns is no longer needed for anything else (#996, R11).
    deviceRow(vault, cred.deviceId, cred.deviceKey);
    const row = vault
      .prepare(
        `SELECT access_agent.agent_id AS agent_id, party_id, status,
                access_agent_secret.enrollment_key AS enrollment_key
           FROM access_agent
           LEFT JOIN access_agent_secret
             ON access_agent_secret.agent_id = access_agent.agent_id
          WHERE access_agent.agent_id = ?`
      )
      .get(cred.agentId) as AgentRow | undefined;
    // No enrollment credential means this file is a seat's copy, not the
    // gateway's: authentication is a gateway act (#996, R2/R3).
    if (!row || row.status !== "active" || row.enrollment_key === null)
      throw new GatewayError("identity", "unknown caller");
    const enrollmentKey = row.enrollment_key;
    return {
      kind: "agent",
      callerId: row.agent_id,
      principalId: enrollmentKey,
      provAgentKind: "ai_agent",
      partyId: row.party_id,
      mayAct: true,
      ...(cred.scopeClamp ? { scopeClamp: cred.scopeClamp } : {}),
      ...(cred.onBehalfOfOwner
        ? { onBehalfOfOwner: cred.onBehalfOfOwner }
        : {}),
      ...(enrollmentKey === ASSISTANT_ENROLLMENT_KEY
        ? { assistant: true as const }
        : {}),
    };
  }
  const device = deviceRow(vault, cred.deviceId, cred.deviceKey);
  const owner = vault
    .prepare("SELECT self_party_id FROM core_vault LIMIT 1")
    .get() as { self_party_id: string | null } | undefined;
  if (!owner?.self_party_id || owner.self_party_id !== device.owner_party_id) {
    throw new GatewayError("identity", "unknown caller");
  }
  // A surface names WHO carried the call, not what it may reach: the reach is
  // the owner's, unchanged, and the label only keeps the evidence legible.
  return {
    kind: "owner-device",
    callerId: cred.surface ?? device.device_id,
    ...(cred.surface === undefined ? {} : { surface: cred.surface }),
    ...(cred.scopeClamp ? { scopeClamp: cred.scopeClamp } : {}),
    provAgentKind: cred.surface === undefined ? "owner" : "app",
    partyId: device.owner_party_id,
    mayAct: true,
  };
}
