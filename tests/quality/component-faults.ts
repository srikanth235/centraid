/**
 * Composition-level fault catalog (issue #842 W3.2).
 *
 * W3.1 breaks the LINK between two healthy components. This catalog breaks the
 * COMPONENTS while the system is mid-work: a gateway that restarts between
 * durable admission and settlement, a gateway whose backend is degraded but
 * still answering, a replica whose process dies with work claimed, an
 * automation worker that dies holding a run claim, and a model-runtime worker
 * that dies holding an enrichment lease.
 *
 * Each entry names the component, what is done to it AT WHAT MOMENT, and the
 * one thing that must be true afterwards. The shared shape of every invariant
 * is CONVERGENCE RATHER THAN CORRUPTION OR WEDGING: the system may lose time,
 * never work, and a dead participant must not hold the system hostage forever.
 *
 * The two lease-shaped faults are asserted through injectable clocks
 * (`ConversationStore.acquireTurnLock(…, now)`, `leaseNextEnrichmentRequest({
 * now })`) rather than by waiting out a real TTL, so the whole catalog runs on
 * the PR path with no wall-clock sleep and no timing assertion anywhere.
 */

export type ComponentId =
  | "gateway"
  | "replica"
  | "automation-worker"
  | "model-runtime";

export interface ComponentFault {
  /** Stable id; also the replay token printed in the test name. */
  readonly id: string;
  readonly component: ComponentId;
  /** What is done, and at which moment of the in-flight work. */
  readonly injection: string;
  /** What must hold afterwards. */
  readonly invariant: string;
}

export const COMPONENT_FAULTS = [
  {
    id: "gateway-restart-mid-dispatch",
    component: "gateway",
    injection:
      "the gateway dies INSIDE dispatch — after durable admission wrote the `sending` row and before any outcome — then the vault plane is reopened from the same directory",
    invariant:
      "the interrupted write neither half-applies nor vanishes: the retry under the same intent id settles it exactly once, and the write that preceded it is untouched",
  },
  {
    id: "gateway-backend-degraded",
    component: "gateway",
    injection:
      "the gateway stays up but its backend answers `retryable` for the whole window — degraded, not dead",
    invariant:
      "a degraded gateway refuses as a typed non-terminal state: nothing is applied, the client's durable outbox keeps the work, and recovery drains it exactly once",
  },
  {
    id: "replica-process-death-mid-send",
    component: "replica",
    injection:
      "the replica's process dies with an intent CLAIMED (`sending`) and no answer, then its durable outbox is reopened from the same file",
    invariant:
      "a claimed-but-unanswered intent survives the death, is recovered to queued by the product's own recovery verb, and applies exactly once on replay",
  },
  {
    id: "automation-worker-death-holding-claim",
    component: "automation-worker",
    injection:
      "an automation worker acquires the persisted turn claim and then dies without releasing it",
    invariant:
      "a live claim cannot be stolen, a dead one is reclaimed at a bounded lease age rather than forever, and the dead worker can neither revive nor release the successor's claim",
  },
  {
    id: "model-runtime-death-holding-lease",
    component: "model-runtime",
    injection:
      "a recognition worker leases an enrichment request and dies without contributing or releasing it",
    invariant:
      "the job is never handed to two workers at once, is reclaimable after its lease expires, is never duplicated in the queue, and a late completion from the dead worker is refused",
  },
] as const satisfies readonly ComponentFault[];

export type ComponentFaultId = (typeof COMPONENT_FAULTS)[number]["id"];

export const COMPONENT_FAULT_IDS: readonly ComponentFaultId[] =
  COMPONENT_FAULTS.map((fault) => fault.id);

export const COMPONENT_FAULT_BY_ID: Readonly<
  Record<ComponentFaultId, ComponentFault>
> = Object.fromEntries(
  COMPONENT_FAULTS.map((fault) => [fault.id, fault])
) as Record<ComponentFaultId, ComponentFault>;

/**
 * Components named by #842 W3.2 that this lane degrades in-process. A
 * component with no entry here would be a silent hole, so the lane asserts
 * this list against the catalog.
 */
export const COMPONENTS_UNDER_CHAOS: readonly ComponentId[] = [
  "gateway",
  "replica",
  "automation-worker",
  "model-runtime",
];
