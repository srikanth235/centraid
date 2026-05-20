/*
 * Non-streaming chat operation: fetch the gateway-wide runner status.
 *
 * Hits the same runtime-core surface that's served identically on OpenClaw
 * and the embedded local runtime, so the desktop main process doesn't need
 * to know which mode it's in. Chat session listing / loading / deletion is
 * the central `/_centraid-chat` surface — see the desktop's
 * `chat-history-client.ts`, which the renderer history list uses directly.
 */

import type { RunnerStatus } from '@centraid/runtime-core';
import type { ChatHarnessConfig } from './types.js';
import { ChatHarnessError } from './chat-client.js';

export async function getRunnerStatus(config: ChatHarnessConfig): Promise<RunnerStatus> {
  return call<RunnerStatus>(config, 'GET', '/centraid/_chat/runner-status');
}

async function call<T>(
  config: ChatHarnessConfig,
  method: string,
  pathAndQuery: string,
): Promise<T> {
  const url = `${trim(config.gatewayUrl)}${pathAndQuery}`;
  const headers: Record<string, string> = {};
  if (config.gatewayToken) headers.authorization = `Bearer ${config.gatewayToken}`;
  const res = await fetch(url, { method, headers });
  const text = await res.text();
  if (!res.ok) {
    throw new ChatHarnessError(`chat-history HTTP ${res.status}`, res.status, text);
  }
  return text ? (JSON.parse(text) as T) : (null as T);
}

function trim(url: string): string {
  return url.replace(/\/+$/, '');
}
