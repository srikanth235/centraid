import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ConversationStore,
  makeLedgerDbProvider,
  ProviderEgressConsentStore,
} from "@centraid/server/engine";
import type { RunTurnFn } from "@centraid/server/engine";
import { tempDir } from "@centraid/test-kit/temp-dir";
import {
  bootstrapVault,
  createGateway,
  createGrant,
  enrollAgent,
  enrollDevice,
  openVaultDb,
  registerLockerCommands,
  registerPeopleCommands,
  registerScheduleCommands,
} from "@centraid/vault";
import type { Credential, Gateway, VaultDb } from "@centraid/vault";

import { startLiveDispatch } from "../automation/run-automation-live-dispatch.js";
import { runFake, vaultToolContext } from "../backends/acp/test-fixtures.js";
import type { HarnessKind } from "../types.js";
import { runVaultInvokeTool, runVaultSqlTool } from "../vault-sql-tool.js";

const PURPOSE = "dpv:ServiceProvision";

export interface Payload {
  id: string;
  carrier: "ics" | "ocr" | "commons";
  category: string;
  invariant:
    | "read-confinement"
    | "risk-park"
    | "egress-no-widen"
    | "no-out-of-grant-entity";
  sentinel: string;
  content: string;
  attempt: Attempt;
  expect: { outcome: "refused" | "parked" | "denied" | "allowed" };
  notes: string;
}

export type Attempt =
  | { tool: "vault_invoke"; command: string; input: Record<string, unknown> }
  | { tool: "vault_sql"; sql: string }
  | { tool: "gateway_read"; entity: string }
  | { tool: "provider_egress"; provider: string };

const CORPUS_DIR = fileURLToPath(new URL("corpus/", import.meta.url));

export function loadCorpus(): Payload[] {
  return readdirSync(CORPUS_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map(
      (name) =>
        JSON.parse(readFileSync(`${CORPUS_DIR}${name}`, "utf8")) as Payload
    );
}

export interface Scenario {
  db: VaultDb;
  gw: Gateway;
  agentCred: Credential;
  owner: Credential;
  agentCtx: ReturnType<typeof vaultToolContext>;
}

export function buildScenario(): Scenario {
  const db = openVaultDb();
  const boot = bootstrapVault(db, { ownerName: "Priya" });
  const gw = createGateway(db);
  registerScheduleCommands(gw);
  registerLockerCommands(gw);
  registerPeopleCommands(gw);

  db.vault
    .prepare(
      `INSERT INTO schedule_calendar (calendar_id, owner_party_id, name, default_tz, visibility)
       VALUES (?, ?, 'Personal', 'Asia/Kolkata', 'private')`
    )
    .run("cal-inject-1", boot.ownerPartyId);

  const agent = enrollAgent(db, { name: "assistant", modelRef: "model-x" });
  const device = enrollDevice(db, boot.ownerPartyId, "agent-host");
  createGrant(db, {
    granteePartyId: agent.partyId,
    purposeConceptId: boot.concepts[PURPOSE] as string,
    grantedByPartyId: boot.ownerPartyId,
    scopes: [
      { schema: "schedule", verbs: "read+act" },
      { schema: "locker", verbs: "read+act" },
    ],
  });
  const agentCred: Credential = {
    kind: "agent",
    agentId: agent.agentId,
    deviceId: device.deviceId,
    deviceKey: device.deviceKey,
  };
  const owner: Credential = {
    kind: "device",
    deviceId: boot.deviceId,
    deviceKey: boot.deviceKey,
  };

  const agentCtx = vaultToolContext({
    vaultSql: (sql: string) => gw.sql(agentCred, { sql }),
    vaultInvoke: (call) =>
      gw.invoke(agentCred, {
        command: call.command,
        input: call.input,
        purpose: PURPOSE,
      }),
  });

  return { db, gw, agentCred, owner, agentCtx };
}

export interface TurnObservation {
  promptText: string;
  vaultCallIsError: boolean | null;
  endedFinal: boolean;
}

export async function runInjectedTurn(
  payload: Payload,
  agentCtx: Scenario["agentCtx"]
): Promise<TurnObservation> {
  const dir = await tempDir("acp-inject-");
  const promptMarker = `${dir}/prompt`;
  const vaultMarker = `${dir}/vault`;

  const { events } = await runFake({
    extraArgs: [
      "--mode=vault",
      "--mcp-http",
      `--prompt-marker=${promptMarker}`,
      `--vault-marker=${vaultMarker}`,
    ],
    toolContext: agentCtx,
    hydrationContext: payload.content,
    forceHydration: true,
  });

  const { promises: fs } = await import("node:fs");
  const promptText = await fs.readFile(promptMarker, "utf8");
  const probe = JSON.parse(await fs.readFile(vaultMarker, "utf8")) as {
    callIsError?: boolean | null;
  };
  const last = events.at(-1);
  return {
    promptText,
    vaultCallIsError: probe.callIsError ?? null,
    endedFinal: last?.type === "final",
  };
}

export type AttemptOutcome =
  | { kind: "refused"; detail: string }
  | { kind: "denied"; detail: string }
  | { kind: "parked"; invocationId: string }
  | { kind: "executed"; detail: string }
  | { kind: "allowed"; rowCount: number };

export async function applyAttempt(
  scenario: Scenario,
  attempt: Attempt
): Promise<AttemptOutcome> {
  if (attempt.tool === "vault_sql") {
    const out = await runVaultSqlTool(scenario.agentCtx, attempt.sql);
    return out.ok
      ? { kind: "executed", detail: "whole-model sql returned rows" }
      : { kind: "refused", detail: out.errorText };
  }
  if (attempt.tool === "vault_invoke") {
    const out = await runVaultInvokeTool(scenario.agentCtx, {
      command: attempt.command,
      input: attempt.input,
    });
    if (!out.ok) return { kind: "refused", detail: out.errorText };
    const outcome = out.result as { status: string; invocationId?: string };
    if (outcome.status === "parked")
      return { kind: "parked", invocationId: outcome.invocationId ?? "" };
    if (outcome.status === "denied")
      return { kind: "denied", detail: "invoke denied by grant scope" };
    return { kind: "executed", detail: outcome.status };
  }
  if (attempt.tool === "gateway_read") {
    try {
      const result = scenario.gw.read(scenario.agentCred, {
        entity: attempt.entity,
        purpose: PURPOSE,
      });
      return { kind: "allowed", rowCount: result.rows.length };
    } catch (error) {
      return {
        kind: "refused",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return applyEgressAttempt(attempt.provider);
}

async function applyEgressAttempt(provider: string): Promise<AttemptOutcome> {
  const kind = provider as HarnessKind;
  const workdir = await tempDir("acp-inject-egress-");
  openVaultDb({ dir: workdir }).close({ skipOptimize: true });
  const ledgerDbFile = path.join(workdir, "vault.db");
  const automationRef = "demo/nightly";
  const store = new ConversationStore(makeLedgerDbProvider(ledgerDbFile));
  store.ensureAutomationConversation(automationRef, "demo", "Nightly", "codex");
  store.close();
  const consent = new ProviderEgressConsentStore(
    makeLedgerDbProvider(ledgerDbFile),
    (member) => member === "codex"
  );
  const before = consent.has(automationRef, kind, "automations");
  const runTurn: RunTurnFn = async (input) => {
    input.onEvent({ type: "final", text: "ok" });
    return { harnessKind: "codex" };
  };
  const dispatch = await startLiveDispatch({
    workdir,
    runId: "run-inject",
    automationRef,
    ledgerDbFile,
    runTurn,
    harness: kind,
    providerEgressConsent: consent,
    consentSource: "ladder",
    onLog: () => undefined,
  });
  let refused = false;
  let detail = "";
  try {
    await dispatch.delegateDispatcher(
      { prompt: "go" },
      {
        runId: "run-inject",
        automationId: automationRef,
        abortSignal: new AbortController().signal,
      }
    );
  } catch (error) {
    refused = true;
    detail = error instanceof Error ? error.message : String(error);
  } finally {
    await dispatch.close().catch(() => undefined);
  }
  const after = consent.has(automationRef, kind, "automations");
  if (before || after)
    return { kind: "executed", detail: "egress consent set widened" };
  return refused
    ? { kind: "refused", detail }
    : { kind: "executed", detail: "dispatch was not refused" };
}

export function partyCountByName(db: VaultDb, displayName: string): number {
  const row = db.vault
    .prepare("SELECT count(*) AS n FROM core_party WHERE display_name = ?")
    .get(displayName) as { n: number };
  return row.n;
}
