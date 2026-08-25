import { useEffect, useState } from "react";

/**
 * Will this host's first key write pop an OS keychain dialog (#603)?
 *
 * Extracted from OnboardingScreen so the ticket panel shared by onboarding
 * and the switcher's "Add vault" modal announces the prompt the same way on
 * both surfaces — two copies of the probe were how the modal came to have no
 * warning at all. The bridge method is desktop-only; a missing method means
 * no prompt, so the hook stays false.
 */
export function useKeychainPromptExpected(): boolean {
  const [expected, setExpected] = useState(false);
  useEffect(() => {
    const probe = window.CentraidApi.keychainPromptExpected;
    if (!probe) return;
    let cancelled = false;
    probe()
      .then((result) => {
        if (!cancelled) setExpected(result);
      })
      .catch((error: unknown) => {
        // A broken probe must not block pairing, but losing the note means the
        // OS dialog arrives unannounced — leave a trace for debugging.
        console.error("keychainPromptExpected probe failed", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return expected;
}
