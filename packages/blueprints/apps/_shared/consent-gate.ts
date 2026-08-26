/**
 * The §8 consent gate (#712 C1/C4): one on-device panel carrying the ONE filled
 * answer (§18), plus one `--net` disclosure panel, outlined and never filled.
 */

/** `net` marks an egress claim: border-only `--net` on web, the `net` role on
 *  native. Never a fill, never a red dot. */
export interface ConsentFact {
  readonly label: string;
  readonly value: string;
  readonly net?: boolean;
}

/** `net: true` borders the panel: it is about bytes leaving. `dangerous` is
 *  only for a genuine third party, never the member's own gateway. */
export interface ConsentPanelCopy {
  readonly eyebrow: string;
  readonly title: string;
  readonly body: string;
  readonly facts: readonly ConsentFact[];
  readonly action: string;
  readonly action2?: string;
  readonly net?: boolean;
  readonly dangerous?: boolean;
  readonly filled?: boolean;
}

/** WHY an answer cannot be given, read beside the control, never after. */
export interface AnswerAvailability {
  readonly available: boolean;
  readonly reason?: string;
}

/** Restated, never imported: server depends on blueprints, and these ship as
 * browser modules. `consent-gate.test.ts` keeps them in lockstep. */
export const ENRICH_DOMAINS = ["photos", "docs"] as const;
export type EnrichDomain = (typeof ENRICH_DOMAINS)[number];

/** `domain` is a structural exclusion, not a policy (C4): Locker has no value
 * to supply, so a Locker consent gate is a type error at the call site. */
export interface ConsentGateProps {
  readonly domain: EnrichDomain;
  readonly onDevicePanel: ConsentPanelCopy;
  readonly onDeviceTitle?: string;
  readonly onDevice: AnswerAvailability;
  /** Never absent: the disclosure renders even when its action cannot be taken. */
  readonly netPanel: ConsentPanelCopy;
  readonly net: AnswerAvailability;
  readonly note: string;
  readonly busy?: boolean;
  readonly answered?: "device" | "declined" | null;
  readonly onRunOnDevice: () => void;
  readonly onDecline: () => void;
  /** Absent when the net action cannot be taken here; the panel still renders. */
  readonly onChooseNet?: () => void;
}
