// S1 — Identity: who is calling? Every caller authenticates as a row
// (consent.app.signing_key, agent.agent, consent.device). No credential, no
// path to data. An unknown caller is dropped at transport: there is no
// grantee to receipt against, so nothing enters the model — not even a
// denial row.

import type { DatabaseSync } from 'node:sqlite';
import type { Credential, Identity } from './types.js';
import { GatewayError } from './types.js';

interface AppRow {
  app_id: string;
  signing_key: string | null;
  status: string;
  risk_ceiling: 'low' | 'medium' | 'high';
}
interface AgentRow {
  agent_id: string;
  party_id: string;
  status: string;
}
interface DeviceRow {
  device_id: string;
  owner_party_id: string;
  public_key: string;
  trust: string;
}

function deviceRow(vault: DatabaseSync, deviceId: string, deviceKey: string): DeviceRow {
  const row = vault
    .prepare(
      'SELECT device_id, owner_party_id, public_key, trust FROM consent_device WHERE device_id = ?',
    )
    .get(deviceId) as DeviceRow | undefined;
  if (!row || row.public_key !== deviceKey || row.trust === 'revoked') {
    throw new GatewayError('identity', 'unknown caller');
  }
  return row;
}

/**
 * Resolve a credential to an Identity or drop it. Signature verification is
 * v0 key-equality against the enrolled row; upgrading to real request
 * signatures only changes this function.
 */
export function authenticate(vault: DatabaseSync, cred: Credential): Identity {
  if (cred.kind === 'app') {
    const row = vault
      .prepare('SELECT app_id, signing_key, status, risk_ceiling FROM consent_app WHERE app_id = ?')
      .get(cred.appId) as AppRow | undefined;
    if (
      !row ||
      row.signing_key === null ||
      row.signing_key !== cred.signingKey ||
      row.status !== 'active'
    ) {
      throw new GatewayError('identity', 'unknown caller');
    }
    return {
      kind: 'app',
      callerId: row.app_id,
      provAgentKind: 'app',
      partyId: null,
      riskCeiling: row.risk_ceiling,
      mayAct: true,
    };
  }
  if (cred.kind === 'agent') {
    // Session binding: an agent call rides an enrolled device's key.
    const device = deviceRow(vault, cred.deviceId, cred.deviceKey);
    const row = vault
      .prepare('SELECT agent_id, party_id, status FROM agent_agent WHERE agent_id = ?')
      .get(cred.agentId) as AgentRow | undefined;
    if (!row || row.status !== 'active') throw new GatewayError('identity', 'unknown caller');
    return {
      kind: 'agent',
      callerId: row.agent_id,
      provAgentKind: 'ai_agent',
      partyId: row.party_id,
      // §03: command risk 'high' requires owner confirmation — agents never
      // exceed medium without a parked confirmation.
      riskCeiling: 'medium',
      mayAct: device.trust === 'full',
    };
  }
  // Owner-direct: an enrolled device belonging to the vault owner.
  const device = deviceRow(vault, cred.deviceId, cred.deviceKey);
  const owner = vault.prepare('SELECT owner_party_id FROM core_vault LIMIT 1').get() as
    | { owner_party_id: string | null }
    | undefined;
  if (!owner?.owner_party_id || owner.owner_party_id !== device.owner_party_id) {
    throw new GatewayError('identity', 'unknown caller');
  }
  return {
    kind: 'owner-device',
    callerId: device.device_id,
    provAgentKind: 'owner',
    partyId: device.owner_party_id,
    riskCeiling: 'owner',
    mayAct: device.trust === 'full',
  };
}
