// THE BUILDER (#996, wave 0e).
//
// One fresh vault, one clock, and thirteen scenarios run through the real
// commands in a fixed order. The result is data — every claim already read back
// through the path a surface reads it through — so the same run can be asserted
// here and replayed by a test in another package without that test knowing
// anything about the vault's internals.

import { createHash } from "node:crypto";

import { bootstrapVault } from "../../../src/bootstrap.js";
import { registerAtlasCommands } from "../../../src/commands/atlas.js";
import { registerDocumentCommands } from "../../../src/commands/documents.js";
import { registerPartyCommands } from "../../../src/commands/parties.js";
import { registerPeopleCommands } from "../../../src/commands/people.js";
import { registerScheduleCommands } from "../../../src/commands/schedule.js";
import { registerTallyCommands } from "../../../src/commands/tally.js";
import { registerTaskCommands } from "../../../src/commands/tasks.js";
import { openVaultDb } from "../../../src/db.js";
import type { VaultDb } from "../../../src/db.js";
import { createGateway } from "../../../src/gateway/gateway.js";
import type { Gateway } from "../../../src/gateway/gateway.js";
import type { Credential, InvokeOutcome } from "../../../src/gateway/types.js";
import { BEHAVIOUR_SCENARIOS } from "./behaviour.js";
import { installFixtureClock } from "./clock.js";
import type { FixtureClock } from "./clock.js";
import { EVIDENCE_SCENARIOS } from "./evidence.js";
import { IDENTITY_SCENARIOS } from "./identity.js";
import { MONEY_SCENARIOS } from "./money.js";
import { executed } from "./types.js";
import type {
  OntologyScenario,
  ScenarioContext,
  ScenarioDefinition,
} from "./types.js";

/** Every scenario, in the order the waves landed them. */
export const ONTOLOGY_SCENARIOS: readonly ScenarioDefinition[] = [
  ...IDENTITY_SCENARIOS,
  ...BEHAVIOUR_SCENARIOS,
  ...MONEY_SCENARIOS,
  ...EVIDENCE_SCENARIOS,
];

export interface OntologyScenarioFixture {
  /** The vault every scenario ran against. The CALLER closes it. */
  readonly db: VaultDb;
  readonly gateway: Gateway;
  readonly owner: Credential;
  readonly ownerPartyId: string;
  readonly scenarios: readonly OntologyScenario[];
  /**
   * sha256 over the scenarios as JSON with identifiers canonicalised — two
   * replays agree or they do not. See `stableDigest`.
   */
  readonly digest: string;
}

export interface BuildOptions {
  /** An already-open vault. Omitted, the builder opens an in-memory one. */
  readonly db?: VaultDb;
  /** The instant the run starts from; the whole run shares it. */
  readonly start?: string;
  /** The vault's base currency — what a single hero figure would be in. */
  readonly baseCurrency?: string;
}

const UUID_LIKE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu;

/**
 * The digest a replay is compared against.
 *
 * Ids minted by a COMMAND are deterministic here — the gateway derives them
 * from the scenario's seed and the mint order. Ids minted by the BOOTSTRAP are
 * not: it has no seed, and the vault, the owner party and the first device are
 * UUIDv7 off the clock. So the digest canonicalises every identifier to the
 * order it first appears in, which is the property a convergence test actually
 * wants — the same rows, in the same order, related the same way.
 */
function stableDigest(value: unknown): string {
  const seen = new Map<string, string>();
  const canonical = JSON.stringify(value).replaceAll(UUID_LIKE, (id) => {
    const known = seen.get(id);
    if (known) return known;
    const token = `#${seen.size + 1}`;
    seen.set(id, token);
    return token;
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function scenarioContext(
  db: VaultDb,
  gateway: Gateway,
  owner: Credential,
  boot: ReturnType<typeof bootstrapVault>,
  clock: FixtureClock,
  seed: string
): ScenarioContext {
  let step = 0;
  const invoke = (
    command: string,
    input: Record<string, unknown>
  ): InvokeOutcome => {
    // A seed per STEP: the id sequence restarts inside each invocation, so one
    // seed for the whole scenario would mint the same ids twice.
    const outcome = gateway.invoke(
      owner,
      { command, input },
      `${seed}:${step++}`
    );
    // Time moves between commands, or "completed just now" and "completed a
    // moment later" are the same instant and the ordering claims say nothing.
    clock.advance(1_000);
    return outcome;
  };
  return {
    db,
    gateway,
    boot,
    owner,
    clock,
    invoke,
    execute: <T>(command: string, input: Record<string, unknown>): T =>
      (executed(invoke(command, input), command) as { output: T }).output,
    rows: <T>(sql: string, ...params: readonly unknown[]): T[] =>
      db.vault.prepare(sql).all(...(params as never[])) as unknown as T[],
    row: <T>(sql: string, ...params: readonly unknown[]): T | undefined =>
      db.vault.prepare(sql).get(...(params as never[])) as T | undefined,
  };
}

export function buildOntologyScenarios(
  options: BuildOptions = {}
): OntologyScenarioFixture {
  const db = options.db ?? openVaultDb();
  const clock = installFixtureClock(options.start);
  try {
    const boot = bootstrapVault(db, {
      ownerName: "Priya",
      baseCurrency: options.baseCurrency ?? "USD",
    });
    const gateway = createGateway(db);
    registerPartyCommands(gateway);
    registerAtlasCommands(gateway);
    registerDocumentCommands(gateway);
    registerScheduleCommands(gateway);
    registerTaskCommands(gateway);
    registerPeopleCommands(gateway);
    registerTallyCommands(gateway);
    const owner: Credential = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
    const scenarios = ONTOLOGY_SCENARIOS.map((definition) => {
      const ctx = scenarioContext(
        db,
        gateway,
        owner,
        boot,
        clock,
        definition.id
      );
      return {
        id: definition.id,
        drift: definition.drift,
        title: definition.title,
        surfaces: definition.surfaces,
        checks: definition.run(ctx),
      } satisfies OntologyScenario;
    });
    return {
      db,
      gateway,
      owner,
      ownerPartyId: boot.ownerPartyId,
      scenarios,
      digest: stableDigest(scenarios),
    };
  } finally {
    clock.restore();
  }
}
