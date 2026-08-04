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
      "Model calls (chat, automations, enrichment) go straight to whichever provider you've set up — Centraid never sits in that path.",
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
      "Device pairing and sync ride the relay-only Iroh transport (the default n0 relay, unless you run your own). It can see that a connection exists and its volume, never its content.",
    source: "SECURITY.md — Threat model: pairing, relay, and gateway (F2)",
  },
  {
    label: "The Centraid Assist OAuth Worker",
    detail:
      "Only when you connect a Google account with Assist: a stateless Cloudflare Worker ferries the authorization code. It never sees your tokens, vault data, or identity.",
    source: "docs/oauth-assist.md",
  },
];
