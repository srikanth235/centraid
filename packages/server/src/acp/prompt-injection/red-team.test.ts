/*
 * Prompt-injection red-team over the agent LOOP (#842). Structural defense, independent of model compliance.
 * (1) out-of-grant read refuses (2) risk/confirm-gated commands PARK (3) egress never WIDENS from content (4) no tool call names an entity outside grant.
 * A breach is a security defect — pin with `test.fails`, do not patch the suite around it. Assert enums / parked queue / egress consent — never ids, timestamps, or ordering (a fake clock would wedge the subprocess turn).
 */

import { describe, expect, test } from "vitest";

import type { Payload, Scenario } from "./harness.js";
import {
  applyAttempt,
  buildScenario,
  loadCorpus,
  partyCountByName,
  runInjectedTurn,
} from "./harness.js";

const corpus = loadCorpus();

const EXPECTED_KIND = {
  refused: "refused",
  denied: "denied",
  parked: "parked",
  allowed: "allowed",
} as const;

/** Only invoke+display_name can write a forbidden entity. */
function forbiddenWriteHappened(scenario: Scenario, payload: Payload): boolean {
  const attempt = payload.attempt;
  if (
    attempt.tool === "vault_invoke" &&
    typeof attempt.input.display_name === "string"
  )
    return partyCountByName(scenario.db, attempt.input.display_name) > 0;
  return false;
}

describe("prompt-injection red-team over the agent surface", () => {
  test("the corpus is non-empty and spans every carrier and invariant", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(10);
    expect(new Set(corpus.map((p) => p.carrier))).toStrictEqual(
      new Set(["ics", "ocr", "commons"])
    );
    expect(new Set(corpus.map((p) => p.invariant))).toStrictEqual(
      new Set([
        "read-confinement",
        "risk-park",
        "egress-no-widen",
        "no-out-of-grant-entity",
      ])
    );
    expect(new Set(corpus.map((p) => p.id)).size).toBe(corpus.length);
  });

  test.each(corpus)(
    "$id: $invariant holds under injection",
    async (payload) => {
      const scenario = buildScenario();

      const turn = await runInjectedTurn(payload, scenario.agentCtx);
      expect(turn.promptText).toContain(payload.sentinel);
      expect(turn.endedFinal).toBe(true);
      expect(turn.vaultCallIsError).toBe(true);

      const outcome = await applyAttempt(scenario, payload.attempt);
      const parked = outcome.kind === "parked";
      const queuedForOwner =
        parked &&
        scenario.gw
          .listParked()
          .some((row) => row.invocationId === outcome.invocationId);
      const rowsReturned = outcome.kind === "allowed" && outcome.rowCount >= 1;

      const evidence = {
        kind: outcome.kind,
        queuedForOwner: parked ? queuedForOwner : "n/a",
        forbiddenWrite: forbiddenWriteHappened(scenario, payload),
        rowsReturned:
          payload.expect.outcome === "allowed" ? rowsReturned : "n/a",
      };

      expect(evidence).toStrictEqual({
        kind: EXPECTED_KIND[payload.expect.outcome],
        queuedForOwner: payload.expect.outcome === "parked" ? true : "n/a",
        forbiddenWrite: false,
        rowsReturned: payload.expect.outcome === "allowed" ? true : "n/a",
      });
    }
  );
});
