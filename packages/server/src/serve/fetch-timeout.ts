// Shared outbound-fetch timeout for broker OAuth refresh and outbox external
// writes: expiry must surface as an ordinary fetch rejection so it lands in
// the callers' existing transient-error handling (#351).
export function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}
