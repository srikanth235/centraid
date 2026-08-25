// Derivative-then-original retry. recyclingKey must change on rung — expo-image caches the failed URL.

import { useCallback, useState } from "react";

export interface ImageFallback {
  source: string;
  failed: boolean;
  decoded: boolean;
  recyclingKey: string;
  handleLoad: () => void;
  handleError: () => void;
}

export function useImageFallback(
  preferred: string,
  original: string | undefined,
  key: string
): ImageFallback {
  const [fellBack, setFellBack] = useState(false);
  const [failed, setFailed] = useState(false);
  const [decoded, setDecoded] = useState(false);

  const canFallBack = !fellBack && !!original && original !== preferred;
  const handleError = useCallback(() => {
    if (canFallBack) setFellBack(true);
    else setFailed(true);
  }, [canFallBack]);

  return {
    source: fellBack && original ? original : preferred,
    failed,
    decoded,
    recyclingKey: fellBack ? `${key}:original` : key,
    handleLoad: useCallback(() => setDecoded(true), []),
    handleError,
  };
}
