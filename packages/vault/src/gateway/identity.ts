// S1 — Identity: every caller authenticates as an enrolled row. An unknown
// caller is dropped at transport, with no grantee to receipt against, so
// nothing enters the model — not even a denial row.

import type { DatabaseSync } from "node:sqlite";

import type { DeviceTrust } from "../grant/device-trust.js";
import { deviceTrustScalarSql } from "../grant/device-trust.js";
import type { Credential, Identity } from "./types.js";
import { GatewayError } from "./types.js";

interface AgentRow {
  agent_id: string;
  party_id: string;
  status: string;
  enrollment_key: string;
}

/** The assistant's enrolment key; the one agent with no standing answer (#928 A3). */
const ASSISTANT_ENROLLMENT_KEY = "_assistant";
interface DeviceIdentityRow {
  device_id: string;
  owner_party_id: string;
  public_key: string;
}

interface DeviceRow extends DeviceIdentityRow {
  /** Undefined when the plane holds no answer about this device. */
  trust: DeviceTrust | undefined;
}

// Two FACTS (#883) — key match and what the member let this device do —
// read in ONE statement: this runs per invocation against a tighten-only
// first-paint budget. `device-trust.ts` owns the mapping.
const DEVICE_IDENTITY_SQL = `SELECT device_id, owner_party_id, public_key,
    ${deviceTrustScalarSql("access_device.device_id")} AS trust
  FROM access_device WHERE device_id = ?`;

function deviceRow(
  vault: DatabaseSync,
  deviceId: string,
  deviceKey: string
): DeviceRow {
  const row = vault.prepare(DEVICE_IDENTITY_SQL).get(deviceId) as
    | (DeviceIdentityRow & { trust: DeviceTrust | null })
    | undefined;
  if (!row || row.public_key !== deviceKey || row.trust === "revoked") {
    throw new GatewayError("identity", "unknown caller");
  }
  // NULL is "no answer at all", never `revoked`.
  return { ...row, trust: row.trust ?? undefined };
}

/** v0 key-equality; real request signatures change only this function. */
export function authenticate(vault: DatabaseSync, cred: Credential): Identity {
  if (cred.kind === "agent") {
    // An autonomous agent principal rides an enrolled device's key.
    const device = deviceRow(vault, cred.deviceId, cred.deviceKey);
    const row = vault
      .prepare(
        "SELECT agent_id, party_id, status, enrollment_key FROM access_agent WHERE agent_id = ?"
      )
      .get(cred.agentId) as AgentRow | undefined;
    if (!row || row.status !== "active")
      throw new GatewayError("identity", "unknown caller");
    return {
      kind: "agent",
      callerId: row.agent_id,
      principalId: row.enrollment_key,
      provAgentKind: "ai_agent",
      partyId: row.party_id,
      mayAct: device.trust === "full",
      ...(cred.scopeClamp ? { scopeClamp: cred.scopeClamp } : {}),
      ...(cred.onBehalfOfOwner
        ? { onBehalfOfOwner: cred.onBehalfOfOwner }
        : {}),
      ...(row.enrollment_key === ASSISTANT_ENROLLMENT_KEY
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
    mayAct: device.trust === "full",
  };
}
