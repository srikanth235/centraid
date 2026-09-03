export type NetworkFaultTier = "in-process" | "needs-netem";

export type NetworkFaultScope = "stream" | "connection" | "endpoint";

export interface NetworkFault {
  readonly id: string;
  readonly tier: NetworkFaultTier;
  readonly scope: NetworkFaultScope;
  readonly injection: string;
  readonly invariant: string;
}

export const NETWORK_FAULTS = [
  {
    id: "latency-uniform",
    tier: "in-process",
    scope: "stream",
    injection:
      "a constant delay before every stream write in both directions — a long, healthy link",
    invariant:
      "a slow link changes when work lands, never whether it lands: the acknowledged write applies exactly once",
  },
  {
    id: "jitter-burst",
    tier: "in-process",
    scope: "stream",
    injection:
      "a seeded per-chunk delay, so concurrent streams interleave differently every draw",
    invariant:
      "interleaving is not arbitration: concurrent submissions of one intent id still apply exactly once",
  },
  {
    id: "fragment-coalesce",
    tier: "in-process",
    scope: "stream",
    injection:
      "each write is split into seeded 1..n-byte pieces, so frames arrive in arrival shapes no cooperative link produces",
    invariant:
      "framing is length-driven, never arrival-shaped: no truncated, merged, or re-parsed frame reaches the vault",
  },
  {
    id: "asymmetric-bandwidth",
    tier: "in-process",
    scope: "stream",
    injection:
      "the uplink is throttled to a small metered chunk rate while the downlink runs free",
    invariant:
      "a starved uplink delivers the whole body or none of it — never a half-applied write",
  },
  {
    id: "abort-mid-request",
    tier: "in-process",
    scope: "stream",
    injection:
      "the request body is cut in half and the send stream is RESET, so the gateway reads a truncated body",
    invariant:
      "an interrupted write does not half-apply, and the retry that follows applies exactly once",
  },
  {
    id: "disconnect-mid-response",
    tier: "in-process",
    scope: "connection",
    injection:
      "the connection is closed after the response HEADER is read and before its body — the caller is left genuinely ambiguous about whether the write landed",
    invariant:
      "the ambiguous retry is idempotent: the same intent id returns the same outcome and mints no second row",
  },
  {
    id: "endpoint-restart",
    tier: "in-process",
    scope: "endpoint",
    injection:
      "the gateway endpoint is closed mid-run and rebound on the SAME secret key at a NEW address",
    invariant:
      "identity is not address: the client re-dials on a refreshed ticket and every queued write converges",
  },
  {
    id: "address-rebind",
    tier: "in-process",
    scope: "endpoint",
    injection:
      "the client endpoint is closed and rebound on the SAME secret key, so the EndpointId survives while the UDP socket does not",
    invariant:
      "an address change is not a new principal: enrolment still admits the seat and nothing is applied twice",
  },
  {
    id: "packet-loss",
    tier: "needs-netem",
    scope: "connection",
    injection:
      "sub-QUIC datagram loss at a named rate, which the transport must recover from below the stream",
    invariant:
      "recovery is the transport's, not the product's: no application-visible loss, and no retransmission amplification",
  },
  {
    id: "packet-reorder",
    tier: "needs-netem",
    scope: "connection",
    injection:
      "sub-QUIC datagram reordering, which the transport must re-sequence below the stream",
    invariant:
      "stream order is restored below the product: frames are read in send order or the connection fails loudly",
  },
] as const satisfies readonly NetworkFault[];

export type NetworkFaultId = (typeof NETWORK_FAULTS)[number]["id"];

export const NETWORK_FAULT_BY_ID: Readonly<
  Record<NetworkFaultId, NetworkFault>
> = Object.fromEntries(
  NETWORK_FAULTS.map((fault) => [fault.id, fault])
) as Record<NetworkFaultId, NetworkFault>;

export const RUNNABLE_NETWORK_FAULT_IDS: readonly NetworkFaultId[] =
  NETWORK_FAULTS.filter((fault) => fault.tier === "in-process").map(
    (fault) => fault.id
  );

export const BLOCKED_NETWORK_FAULT_IDS: readonly NetworkFaultId[] =
  NETWORK_FAULTS.filter((fault) => fault.tier === "needs-netem").map(
    (fault) => fault.id
  );

export const NETEM_UNBLOCK =
  "a privileged Linux runner able to create a network namespace and attach " +
  "`tc qdisc add dev <veth> root netem loss <p>% reorder <p>%` between two " +
  "iroh endpoints (CAP_NET_ADMIN). Hosted GitHub runners have it; this " +
  "process does not request it, and no netem driver is wired, so the two " +
  "sub-QUIC faults are declared here rather than staged vacuously.";

export const NETEM_ENV = "CENTRAID_NET_CHAOS_NETEM";
