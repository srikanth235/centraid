/*
 * Every network call the product makes off this device (issue #708 section
 * A2's "footer naming every network call"). Hand-enumerated from the repo's
 * own threat model and design docs rather than the client's code paths,
 * because most of these calls are made gateway-side, out of this bundle's
 * reach — this list is documentation, not instrumentation. Keep it in sync
 * with its cited source when that source changes.
 */

export interface NetworkCallDTO {
  label: string;
  detail: string;
  /** Doc this entry is sourced from, for anyone re-verifying the list. */
  source: string;
}

export const NETWORK_CALLS: readonly NetworkCallDTO[] = [
  {
    label: "Your configured AI provider",
    detail:
      "Model calls go straight to the provider you set up — Centraid never sits in that path.",
    source: "docs/decisions.md (provider-agnostic inference)",
  },
  {
    label: "Your backup provider",
    detail:
      "Offsite copy traffic is end-to-end encrypted, but the provider can see object counts, sizes, and write cadence.",
    source: "SECURITY.md — Known metadata exposure to backup providers",
  },
  {
    label: "The pairing relay",
    detail:
      "Pairing and sync ride the Iroh relay, which sees connection volume but never content.",
    source: "SECURITY.md — Threat model: pairing, relay, and gateway (F2)",
  },
  {
    label: "The Centraid Assist OAuth Worker",
    detail:
      "A stateless Cloudflare Worker ferries Google authorization codes — never tokens or vault data.",
    source: "docs/oauth-assist.md",
  },
];
