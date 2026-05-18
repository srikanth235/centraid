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
 * Replaces the earlier pi-coding-agent embed; the harness no longer
 * runs any inference loop itself. Tools live server-side (OpenClaw
 * registers them; the local runtime spawns a stdio MCP server exposing
 * the same surface).
 *
 * See @centraid/builder-harness for the app-authoring agent — that
 * client still uses pi-coding-agent locally, intentionally.
 */

export {
  openChatStream,
  type OpenChatStreamOptions,
  type ChatStreamHandle,
} from './chat-client.js';
export {
  fetchChatHistory,
  listChatWindows,
  clearChatWindow,
  getRunnerStatus,
  type ChatHistoryResult,
  type ChatWindowListResult,
} from './chat-history.js';
export type { ChatHarnessConfig } from './types.js';

// Re-export the runtime-core chat types so callers don't have to depend
// on runtime-core directly to consume the streaming event union.
export type {
  ChatMode,
  ChatStreamEvent,
  ChatWindowMeta,
  RunnerStatus,
} from '@centraid/runtime-core';
