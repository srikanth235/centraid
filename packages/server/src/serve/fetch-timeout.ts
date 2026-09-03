export function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}
