/**
 * THE §8 CONSENT GATE — SHARED SHAPE (issue #712 C1/C4).
 *
 * Two instances of the same product law live in this repo: Photos' face
 * detection (`apps/photos/enrichment-consent.ts`) and Docs' capture-time OCR
 * (`apps/_shared/capture-consent.ts`, Scan.tsx's consent latch). Both are one
 * on-device/primary panel — an eyebrow, a question, one paragraph, a fact
 * table, and the ONE filled answer (§18) — plus one `--net`-bordered panel
 * that discloses what would leave the device, outlined and never filled.
 * This module is the shape both read; `ConsentGate.tsx` (this directory, web)
 * and `apps/mobile/src/kit/components/ConsentGate.tsx` (native) are the two
 * renderers of it.
 *
 * `photos/enrichment-consent.ts` re-exports `ConsentFact`/`ConsentPanelCopy`/
 * `AnswerAvailability` from here for compatibility — every existing importer
 * of that module keeps working unchanged.
 */

/** One `label → value` line in a panel's fact table, rendered in the mono
 *  register. `net` marks the fact as an egress claim — the border-only
 *  `--net` treatment on web, the `net` role on native. It is never a fill and
 *  never a red dot. */
export interface ConsentFact {
  readonly label: string;
  readonly value: string;
  readonly net?: boolean;
}

/** One consent panel: an eyebrow, a question, one paragraph, the facts, and
 *  the answer(s) it accepts. `net: true` renders the whole panel bordered in
 *  `--net` — the panel itself is about bytes leaving. `dangerous` additionally
 *  styles the panel's own action in `--danger` (web) for the rare case where
 *  the disclosed egress is to a genuinely third-party recipient, as opposed
 *  to the member's own gateway. */
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

/** Whether an answer can be given, and — when it cannot — WHY, in words the
 *  member reads beside the control rather than discovering afterwards. */
export interface AnswerAvailability {
  readonly available: boolean;
  readonly reason?: string;
}

/**
 * The domains `enrich_policy` is keyed by — restated from
 * `packages/server/src/automation/fire/enrich-gate.ts`'s `ENRICH_DOMAINS`, not
 * imported from it: `@centraid/server/automation` depends on `@centraid/blueprints`
 * (see its package.json), so the reverse import would be a cycle, and
 * blueprint apps are served as browser ES modules that may not pull in a
 * Node-only package regardless (the same constraint documented at the top of
 * `placement-registry.ts`). Kept in lockstep by a source-scan tripwire
 * (`consent-gate.test.ts`), the same technique
 * `placement-registry.test.ts` uses for vault's `SHAREABLE_ITEM_TYPES`.
 */
export const ENRICH_DOMAINS = ["photos", "docs"] as const;
export type EnrichDomain = (typeof ENRICH_DOMAINS)[number];

/**
 * The gate's full prop shape (issue #712 C1). `domain` is required and typed
 * as `EnrichDomain` — a structural exclusion, not a policy (C4): Locker has
 * no `"photos" | "docs"` value to supply, so a Locker consent gate is a type
 * error at the call site, the same way `PLACEMENT_REGISTRY` structurally
 * excludes `locker.item` (A7, `placement-registry.test.ts`).
 */
export interface ConsentGateProps {
  /** Which `enrich_policy` domain this consent moment is about. Never used to
   *  branch copy — copy is supplied whole by the caller — only to make the
   *  gate un-renderable for a domain that cannot produce one. */
  readonly domain: EnrichDomain;
  /** The on-device/primary panel — the ONE filled answer (§18). */
  readonly onDevicePanel: ConsentPanelCopy;
  /** A live-formatted title override (e.g. a count-based question). Falls
   *  back to `onDevicePanel.title` when absent. */
  readonly onDeviceTitle?: string;
  readonly onDevice: AnswerAvailability;
  /** The bordered `--net` panel — outlined, never filled, and never absent:
   *  the disclosure renders even when its action cannot be taken. */
  readonly netPanel: ConsentPanelCopy;
  readonly net: AnswerAvailability;
  /** The note under both panels — "this is not a settings toggle". */
  readonly note: string;
  /** A write is in flight; both answers go unavailable. */
  readonly busy?: boolean;
  /** Latched once answered, so the question stops offering itself. */
  readonly answered?: "device" | "declined" | null;
  readonly onRunOnDevice: () => void;
  readonly onDecline: () => void;
  /** Absent while the net panel's action cannot be taken from here (either
   *  genuinely unwired, like Photos' cloud helper, or — like Docs' gateway
   *  backstop — not a separate choice at all). The panel still renders. */
  readonly onChooseNet?: () => void;
}
