// Extracted from ReplicaProvider for the repo's 625-line cap (same reason
// first-run.mjs left harness.mjs): one scheduler seam with no edge back to the
// provider that uses it.

import { InteractionManager } from "react-native";

/**
 * Resolve once the navigation animation and pending touches have run. React
 * Native's own scheduler owns this — nothing here should be guessing at a
 * timeout for "the UI is usable now".
 */
export function afterInteractions(): Promise<void> {
  return new Promise((resolve) => {
    InteractionManager.runAfterInteractions(() => resolve());
  });
}
