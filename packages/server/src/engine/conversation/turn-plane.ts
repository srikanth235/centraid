import type { RunTurnFn, TurnInput, TurnResult, HarnessPrefs } from "./turn.js";

export const TURN_HYDRATION_TOKEN_BUDGET = 8_000;
export const TURN_HYDRATION_MIN_TURNS = 2;

export interface TurnPosture {
  readonly surface: "interactive" | "automation";
  readonly egress: "attended" | "unattended";
  readonly egressConsent: () => boolean | Promise<boolean>;
  readonly failover: "turn-boundary" | "fire-boundary" | "none";
  readonly permissionPolicy: "auto-allow" | "deny";
  readonly artifacts: "capture" | "delegate-only";
}

export interface TurnPlaneEgressDeniedError extends Error {
  readonly code: "provider-egress-consent-required";
  readonly harnessKind: HarnessPrefs["kind"];
  readonly egress: TurnPosture["egress"];
}

function egressDeniedError(
  harnessKind: HarnessPrefs["kind"],
  egress: TurnPosture["egress"]
): TurnPlaneEgressDeniedError {
  return Object.assign(
    new Error(`${egress} provider egress to ${harnessKind} is not consented`),
    {
      name: "TurnPlaneEgressDeniedError",
      code: "provider-egress-consent-required" as const,
      harnessKind,
      egress,
    }
  );
}

export class TurnPlane {
  constructor(private readonly dispatch: RunTurnFn) {}

  async runTurn(
    input: TurnInput,
    prefs: HarnessPrefs,
    posture: TurnPosture
  ): Promise<TurnResult> {
    if (
      typeof posture.egressConsent !== "function" ||
      !(await posture.egressConsent())
    ) {
      throw egressDeniedError(prefs.kind, posture.egress);
    }
    return this.dispatch(
      {
        ...input,
        permissionPolicy: input.permissionPolicy ?? posture.permissionPolicy,
      },
      { prefs }
    );
  }
}
