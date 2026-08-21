/*
 * Red-team harness for the prompt-injection corpus (#842 slice A5 / W2.2).
 *
 * #630 hardened the DISPLAY of hostile content; nothing attacked the AGENT
 * LOOP. This helper drives the real ACP turn machinery — the same
 * `runAcpTurn` seam the backend suite exercises via `fake-acp-harness.mjs`,
 * imported through `test-fixtures.ts`, no parallel fake — against a REAL vault
 * gateway confined to a single agent grant. The fake harness plays the DUPED
 * agent: whatever an injected instruction "convinces" it to do, the structural
 * boundary is the gateway credential + grant, not the model's compliance.
 *
 * Each corpus payload carries hostile content plus the one tool call the
 * injection tries to induce. We run the content through a real turn (proving it
 * enters the agent's context and that the agent's blanket vault reach is
 * refused), then push the induced op through the SAME confined executor the
 * turn wires and assert the structural outcome — parked, denied, refused, or,
 * for the negative control, an in-grant read that still works.
 *
 * Determinism: every assertion is on a structural enum (invoke status, a thrown
 * consent deny, the parked queue, the egress consent set) — never on an id,
 * timestamp, or ordering. So the suite is deterministic without a fake clock,
 * which matters because the turn spawns a real subprocess doing real stdio/HTTP
 * I/O that `vi.useFakeTimers()` would wedge.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
import {
  ConversationStore,
  makeJournalDbProvider,
  ProviderEgressConsentStore,
} from "@centraid/server/engine";
import type { RunTurnFn } from "@centraid/server/engine";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { startLiveDispatch } from "../automation/run-automation-live-dispatch.js";
import type { LiveDispatch } from "../automation/run-automation-live-dispatch.js";
import type { HarnessKind } from "../types.js";
import { runVaultInvokeTool, runVaultSqlTool } from "../vault-sql-tool.js";
import { runFake, vaultToolContext } from "../backends/acp/test-fixtures.js";

const PURPOSE = "dpv:ServiceProvision";

/** One hostile fixture: carrier content + the induced tool call + its expected structural fate. */
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

/**
 * Discover the corpus from disk — GROW-ONLY. Dropping a new `*.json` in
 * `corpus/` is picked up automatically; nothing here hardcodes the list.
 */
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
  /** The ACP ToolContext the turn wires: every vault runner is agent-confined. */
  agentCtx: ReturnType<typeof vaultToolContext>;
}

/**
 * A vault whose only agent grant is `schedule` + `locker` (read+act). Reads of
 * any other schema, whole-model SQL, and out-of-grant commands are all outside
 * the turn's authority; `locker.purge_item` is in-grant but confirm-gated.
 */
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
    // vault_sql is the owner's whole-model surface; an agent turn is refused.
    vaultSql: (sql: string) => gw.sql(agentCred, { sql }),
    // The typed write path, executed under the agent grant: out-of-grant
    // commands deny, confirm-gated commands park.
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
  /** The serialized `session/prompt` content the fake harness received. */
  promptText: string;
  /** The `--mode=vault` probe: did the agent's whole-model read come back refused? */
  vaultCallIsError: boolean | null;
  /** Did the turn reach a terminal `final` event? */
  endedFinal: boolean;
}

/**
 * Drive the hostile content through a REAL turn against the fake ACP harness.
 * The harness dials the per-turn loopback MCP server backed by `agentCtx`, so
 * the only path it has to the vault is the confined executor.
 */
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

/** The structural fate of an induced op, normalized across the tool surfaces. */
export type AttemptOutcome =
  | { kind: "refused"; detail: string }
  | { kind: "denied"; detail: string }
  | { kind: "parked"; invocationId: string }
  | { kind: "executed"; detail: string }
  | { kind: "allowed"; rowCount: number };

/**
 * Push the induced op through the SAME confined executor the turn wired —
 * `runVault*Tool` for the MCP tool surface, `gw.read` for the agent-scoped row
 * read — and report only the structural outcome.
 */
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

/**
 * Egress widening: the durable provider-egress consent set is seeded with the
 * automation's ONE consented provider (codex). Content asking to route through
 * an unlisted provider must not add it — the ladder membership predicate is
 * content-independent, so the dispatch is refused and the grant set unchanged.
 */
async function applyEgressAttempt(provider: string): Promise<AttemptOutcome> {
  const workdir = await tempDir("acp-inject-egress-");
  const journalDbFile = `${workdir}/journal.db`;
  const automationRef = "demo/nightly";
  const store = new ConversationStore(makeJournalDbProvider(journalDbFile));
  store.ensureAutomationConversation(automationRef, "demo", "Nightly", "codex");
  store.close();
  // The live ladder holds codex only; the injected provider is not a member.
  const consent = new ProviderEgressConsentStore(
    makeJournalDbProvider(journalDbFile),
    (kind) => kind === "codex"
  );
  const before = consent.has(automationRef, provider, "automations");
  const runTurn = vi_fnNoop();
  const dispatch = await startLiveDispatch({
    workdir,
    runId: "run-inject",
    automationRef,
    journalDbFile,
    runTurn,
    harness: provider as HarnessKind,
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
  const after = consent.has(automationRef, provider, "automations");
  if (before || after)
    return { kind: "executed", detail: "egress consent set widened" };
  return refused
    ? { kind: "refused", detail }
    : { kind: "executed", detail: "dispatch was not refused" };
}

/**
 * A no-op `RunTurnFn` — the egress gate refuses an unlisted provider BEFORE the
 * turn runs, so this must never be reached for the widening payloads. Kept out
 * of a `vitest` import so the harness module stays import-clean.
 */
function vi_fnNoop(): RunTurnFn {
  return (async (input) => {
    input.onEvent({ type: "final", text: "ok" });
    return { harnessKind: "codex" };
  }) as unknown as RunTurnFn;
}

/** How many `core_party` rows carry this display name (for "no write" checks). */
export function partyCountByName(db: VaultDb, displayName: string): number {
  const row = db.vault
    .prepare(
      "SELECT count(*) AS n FROM core_party WHERE display_name = ?"
    )
    .get(displayName) as { n: number };
  return row.n;
}

export type { LiveDispatch };
