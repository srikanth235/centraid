/*
 * Turn postures (issue #743 Part 2) — the four callers that reach a harness
 * differ by DATA, not by code path.
 *
 * Chat, the builder, headless compile, interactive steering, and automation
 * `ctx.delegate` all drive the same injected, resource-accounted `RunTurnFn`.
 * What legitimately differs between them — is egress prompted or derived, how
 * much ledger may be re-folded into a cold session, may the agent act on a
 * permission request — is stated once here instead of being rediscovered per
 * call site. The automation dispatch forked its own answers to exactly these
 * questions and drifted; this table is what replaces that fork.
 *
 * Two columns of the issue's table are still expressed structurally rather
 * than read from here, and are recorded so the table does not lie:
 *   - `failover` — in-turn rungs live in `runner-core.ts`, new-run rungs in
 *     agent-runtime's `run-automation.ts`. Both spines already own their own
 *     ladder walk; the field names which one a caller gets.
 *   - `artifacts` — today a caller gets artifacts by being handed a writable
 *     worktree cwd, not by a flag. It joins the read set when the one door
 *     owns cwd resolution.
 */

/** The four callers that reach a harness. */
export type TurnPostureName = "chat" | "steering" | "compile" | "fire";

export interface TurnPosture {
  /**
   * `prompt` — an attended surface may emit `consent.required` and wait.
   * `derived` — unattended egress is authorized at authoring time (#567 D5),
   * so the grant is DERIVED from the user's live ladder or denied (D13). It
   * is never prompted, because nobody is there to answer.
   */
  readonly consent: "prompt" | "derived";
  /** Where the next ladder rung is selected: inside this turn, or one level up. */
  readonly failover: "in-turn" | "new-run";
  /** Budget for every hydration fold this caller compiles. */
  readonly hydration: {
    readonly tokenBudget: number;
    /** Most recent turns carried verbatim even when the budget is tight. */
    readonly minTurns: number;
  };
  readonly permissions: "auto-allow" | "deny";
  /** Whether the turn may leave artifacts (worktree edits) behind. */
  readonly artifacts: boolean;
}

/**
 * One hydration budget for every caller. A cold session's re-fold costs the
 * same tokens whoever asked for it, so the number is a property of the ledger,
 * not of the surface — which is precisely why the automation fork's absent
 * budget was a bug rather than a policy.
 */
const HYDRATION = { tokenBudget: 8_000, minTurns: 2 } as const;

export const TURN_POSTURES: Record<TurnPostureName, TurnPosture> = {
  chat: {
    consent: "prompt",
    failover: "in-turn",
    hydration: HYDRATION,
    permissions: "auto-allow",
    artifacts: true,
  },
  steering: {
    consent: "prompt",
    failover: "in-turn",
    hydration: HYDRATION,
    permissions: "deny",
    artifacts: true,
  },
  compile: {
    consent: "derived",
    failover: "new-run",
    hydration: HYDRATION,
    permissions: "deny",
    artifacts: false,
  },
  fire: {
    consent: "derived",
    failover: "new-run",
    hydration: HYDRATION,
    permissions: "deny",
    artifacts: false,
  },
};
