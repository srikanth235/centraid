// The one place the engine asks the platform what the radio is. Separate from
// `policy.ts` on purpose: that module is the CLASSIFICATION and stays free of
// expo modules so it is testable as logic; this is the reading, and it is the
// only file in the engine that needs `expo-network`.

import * as Network from "expo-network";

/**
 * The platform's own answer, as the plain string `policy.ts` compares against.
 * `undefined` when the platform will not say — which `defaultFetchPolicy`
 * treats as unmetered rather than guessing a tap in front of every fetch.
 */
export async function currentNetworkType(): Promise<string | undefined> {
  try {
    const state = await Network.getNetworkStateAsync();
    return state.type === undefined ? undefined : String(state.type);
  } catch {
    return undefined;
  }
}
