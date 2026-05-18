/*
 * Shared types for the chat-harness HTTP/SSE client.
 *
 * `ChatHarnessConfig` is a deliberate subset of `HarnessConfig` from
 * `@centraid/builder-harness` — we only need the gateway URL + token to
 * hit the chat surface; nothing about projects directories belongs here.
 * Callers (the desktop main) typically pass their full `HarnessConfig`
 * since it's structurally compatible.
 */

export interface ChatHarnessConfig {
  /** Base URL of either the OpenClaw gateway or the embedded local runtime. */
  gatewayUrl: string;
  /** Bearer token; required for the embedded local runtime, optional for
   *  OpenClaw deployments configured without auth. */
  gatewayToken?: string;
}
