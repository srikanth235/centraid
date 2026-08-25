// The CLASSIFICATION half of "may I fetch this now?": whether the connection
// is one the member pays for by the byte. Consent — has this member said yes,
// and to what — is the caller's state (`gate.ts`, `consented`).
//
// SEAM, NOT IMPORT. Do not import `apps/mobile/src/kit/transfer/`; when its
// frame-level policy store lands (decisions.md S4), pass a `FetchPolicy`
// backed by it where `defaultFetchPolicy` goes today — no caller changes.

export type ConnectionKind = "metered" | "unmetered" | "unknown";

export interface FetchPolicy {
  /** `unknown` (absent or unrecognised type) is treated as `unmetered` and
   *  never gates: guessing "metered" for what the platform does not report
   *  would put an unwanted tap in front of every fetch there. */
  connectionKind: (networkType: string | undefined) => ConnectionKind;
}

/** Compared as plain strings, not against `NetworkStateType`, so this module
 *  stays free of `expo-modules-core` and testable as logic. */
const METERED_NETWORK_TYPES = new Set(["CELLULAR", "WIMAX"]);

export const defaultFetchPolicy: FetchPolicy = {
  connectionKind(networkType: string | undefined): ConnectionKind {
    if (networkType === undefined) return "unknown";
    return METERED_NETWORK_TYPES.has(networkType) ? "metered" : "unmetered";
  },
};
