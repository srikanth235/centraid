import { useEffect, useState } from "react";

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
        console.error("keychainPromptExpected probe failed", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return expected;
}
