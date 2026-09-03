export type ComponentId =
  | "gateway"
  | "replica"
  | "automation-worker"
  | "model-runtime";

export interface ComponentFault {
  readonly id: string;
  readonly component: ComponentId;
  readonly injection: string;
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

export const COMPONENTS_UNDER_CHAOS: readonly ComponentId[] = [
  "gateway",
  "replica",
  "automation-worker",
  "model-runtime",
];
