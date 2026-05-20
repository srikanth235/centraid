/*
 * @centraid/chat-harness
 *
 * Host-agnostic HTTP/SSE client for centraid's per-app chat surface.
 *
 * The per-app chat endpoint (`POST /centraid/<appId>/_chat`) lives in
 * `@centraid/runtime-core` and is served identically by both gateway hosts
 * (OpenClaw plugin + the desktop's embedded local runtime). The harness
 * client doesn't know which one it's pointed at — same URL contract.
 *
 * The harness runs no inference loop itself; turns are driven server-side
 * by whichever `ChatRunner` the host injected (OpenClaw's in-process
 * runner, or `@centraid/agent-runtime`'s `makeChatRunner` on the local
 * runtime). See @centraid/builder-harness for the separate app-authoring
 * agent surface, which uses the same agent runtime via `runAgentTurn`.
 */

export {
  openChatStream,
  type OpenChatStreamOptions,
  type ChatStreamHandle,
} from './chat-client.js';
export { getRunnerStatus } from './chat-history.js';
export type { ChatHarnessConfig } from './types.js';

// Re-export the runtime-core chat types so callers don't have to depend
// on runtime-core directly to consume the streaming event union.
export type { ChatMode, ChatStreamEvent, RunnerStatus } from '@centraid/runtime-core';
