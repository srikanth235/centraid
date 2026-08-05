// The policy-read contract for one question every byte-bearing app asks
// before it spends a member's mobile data: "may I fetch this now, or does the
// member have to say so?"
//
// This module answers only the CLASSIFICATION half of that question — is the
// current connection one the member typically pays for by the byte? The
// CHOICE half (has this member already said yes, and to what) is state the
// caller owns (see gate.ts's `consented` parameter), because consent is
// per-photo / per-document / per-session in a way a shared policy object
// cannot know.
//
// SEAM, NOT IMPORT. The transfer engine (`apps/mobile/src/kit/transfer/`,
// a separate workstream, UP direction — device to gateway) is expected to own
// a frame-level policy store: one Wi-Fi/charging/roaming record consulted by
// every byte-bearing app, per docs/decisions.md S4 ("one policy for every
// byte-bearing app"). This module deliberately does NOT import from that
// namespace — it isn't there yet, and even once it lands the two engines
// should stay decoupled at the type level. Instead this file declares the
// interface DOWN-direction callers need and ships a default implementation
// that reproduces today's photos behaviour (metered ⇒ ask). When the UP
// engine's policy store exists, the intended change is a single call site: a
// `FetchPolicy` implementation backed by that store, passed in wherever a
// caller currently relies on `defaultFetchPolicy`. No caller of `fetchAccess`
// (gate.ts) or `MeteredGate`/`gatedByPolicy` should need to change shape.

/** What the OS-reported connection type means for a "may I fetch" answer. */
export type ConnectionKind = "metered" | "unmetered" | "unknown";

export interface FetchPolicy {
  /**
   * Classify a raw `NetworkState["type"]` string. `unknown` covers an absent
   * or unrecognised type — an "I don't know" is a strong claim, and this gate
   * treats it as `unmetered` (never gates), matching §current photos
   * behaviour: guessing "metered" for a type the platform simply does not
   * report would put an unwanted tap in front of every fetch on that platform.
   */
  connectionKind: (networkType: string | undefined) => ConnectionKind;
}

/**
 * Types RN/Expo's `NetworkStateType` reports for connections a member
 * typically pays for by the byte. Compared as plain strings, not against the
 * `NetworkStateType` enum, so this module stays free of `expo-modules-core`
 * and is exercisable as plain logic in tests — `NetworkStateType` is a string
 * enum whose members are exactly these values.
 */
const METERED_NETWORK_TYPES = new Set(["CELLULAR", "WIMAX"]);

/**
 * The default policy, used until a frame-level policy store exists. Reproduces
 * exactly what `full-quality-gate.ts` did before this extraction: cellular and
 * WiMAX are metered, everything reported and everything unreported is not.
 */
export const defaultFetchPolicy: FetchPolicy = {
  connectionKind(networkType: string | undefined): ConnectionKind {
    if (networkType === undefined) return "unknown";
    return METERED_NETWORK_TYPES.has(networkType) ? "metered" : "unmetered";
  },
};
