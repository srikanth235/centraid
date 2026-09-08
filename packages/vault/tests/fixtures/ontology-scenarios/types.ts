// THE SHAPE OF A SCENARIO (#996, wave 0e).
//
// A scenario is not a test. It is a RUN — real commands against a fresh vault —
// plus the claims that run makes, each already read back through the path a
// surface reads it through. The claims travel as data so that a test in ANOTHER
// package (W1's convergence run) can assert them without importing anything of
// the vault's internals, and so that a reader which ignores a stored column is
// red wherever the fixture is replayed rather than only here.

import type { BootstrapResult } from "../../../src/bootstrap.js";
import type { VaultDb } from "../../../src/db.js";
import type { Gateway } from "../../../src/gateway/gateway.js";
import type { Credential, InvokeOutcome } from "../../../src/gateway/types.js";
import type { FixtureClock } from "./clock.js";

/** One claim a scenario makes, already evaluated. `actual` is what the read
 *  path answered; `expected` is what the ruling says it must answer. */
export interface ScenarioCheck {
  /** The claim in a sentence, as it should read in a failure. */
  readonly claim: string;
  readonly actual: unknown;
  readonly expected: unknown;
}

export interface OntologyScenario {
  /** `<drift row>/<slug>`, stable across runs — W1 replays cite it. */
  readonly id: string;
  /** The drift-register row this scenario reproduces, e.g. `ONT-25`. */
  readonly drift: string;
  readonly title: string;
  /** The two app surfaces the command→query round trip crosses. */
  readonly surfaces: readonly [string, string];
  readonly checks: readonly ScenarioCheck[];
}

/** What a scenario is handed: a bootstrapped vault, its owner credential, the
 *  gateway with every command it needs registered, and the fixture clock. */
export interface ScenarioContext {
  readonly db: VaultDb;
  readonly gateway: Gateway;
  readonly boot: BootstrapResult;
  readonly owner: Credential;
  readonly clock: FixtureClock;
  /** Invoke and hand back the outcome, refusals included — several scenarios
   *  are ABOUT a refusal. Ids are minted from the scenario's own seed. */
  readonly invoke: (
    command: string,
    input: Record<string, unknown>
  ) => InvokeOutcome;
  /** Invoke, insist it executed, and hand back its output. */
  readonly execute: <T>(command: string, input: Record<string, unknown>) => T;
  /** Every row of a query, as plain objects. */
  readonly rows: <T>(sql: string, ...params: readonly unknown[]) => T[];
  /** The one row a query answers, or `undefined`. */
  readonly row: <T>(
    sql: string,
    ...params: readonly unknown[]
  ) => T | undefined;
}

export interface ScenarioDefinition {
  readonly id: string;
  readonly drift: string;
  readonly title: string;
  readonly surfaces: readonly [string, string];
  readonly run: (ctx: ScenarioContext) => ScenarioCheck[];
}

/** A refusal where the scenario needed an execution is a broken fixture, not a
 *  failed assertion — it must stop the build rather than travel as a check. */
export function executed(outcome: InvokeOutcome, what: string): InvokeOutcome {
  if (outcome.status !== "executed") {
    throw new Error(
      `${what}: expected executed, got ${outcome.status} — ${
        (outcome as { reason?: string }).reason ?? "no reason given"
      }`
    );
  }
  return outcome;
}
