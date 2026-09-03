import { useEffect, useState } from "react";

export const COMPACT_MAX_WIDTH = 720;

const QUERY = `(max-width: ${COMPACT_MAX_WIDTH}px)`;

export function useCompactLayout(): boolean {
  const [compact, setCompact] = useState(() => {
    if (typeof matchMedia !== "function") return false;
    return matchMedia(QUERY).matches;
  });

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(QUERY);
    const sync = (): void => setCompact(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  return compact;
}
