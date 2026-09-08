/**
 * ONE AUTOMATION PRINCIPAL, ANSWERED — the opening every suite that used to
 * enrol an app and mint it a grant now writes (#928).
 *
 * A first-party app is not a principal, so a suite about "a caller the owner
 * has scoped" is a suite about an AUTOMATION: it enrols under its own id,
 * rides the owner's device key, and holds `share_authority` rows the owner
 * wrote. This mints exactly that, so a suite states what it is about rather
 * than restating the plane.
 */
import type { BootstrapResult } from "../bootstrap.js";
import { enrollAgent } from "../bootstrap.js";
import type { VaultDb } from "../db.js";
import type { Credential, ExecutionScopeSpec } from "../gateway/types.js";
import { nowIso } from "../ids.js";
import type { AutomationScope } from "./automation-authority.js";
import {
  automationAnswers,
  automationSubjectsOf,
  recordAutomationAnswers,
} from "./automation-authority.js";

export interface AnsweredAutomation {
  name: string;
  agentId: string;
  partyId: string;
  credential: Credential;
}

/** Enrol an automation and record the owner's YES for `scopes`. */
export function answeredAutomation(
  db: VaultDb,
  boot: BootstrapResult,
  name: string,
  scopes: readonly AutomationScope[],
  options: { clamp?: readonly ExecutionScopeSpec[] } = {}
): AnsweredAutomation {
  const agent = enrollAgent(db, { name, modelRef: "test-automation" });
  if (scopes.length > 0)
    recordAutomationAnswers(db.vault, {
      principalId: name,
      ownerPartyId: boot.ownerPartyId,
      subjects: automationSubjectsOf(scopes),
      decision: "granted",
      now: nowIso(),
    });
  return {
    name,
    agentId: agent.agentId,
    partyId: agent.partyId,
    credential: {
      kind: "agent",
      agentId: agent.agentId,
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
      ...(options.clamp ? { scopeClamp: options.clamp } : {}),
    },
  };
}

/**
 * Record the owner's answer for an already-enrolled automation, and hand back
 * the live authority ids — what a receipt names, and what a withdrawal takes.
 */
export function answerScopes(
  db: VaultDb,
  boot: BootstrapResult,
  principalId: string,
  scopes: readonly AutomationScope[],
  decision: "granted" | "declined" = "granted"
): string[] {
  recordAutomationAnswers(db.vault, {
    principalId,
    ownerPartyId: boot.ownerPartyId,
    subjects: automationSubjectsOf(scopes),
    decision,
    now: nowIso(),
  });
  return automationAnswers(db.vault, principalId).map(
    (answer) => answer.authorityId
  );
}
