/*
 * Non-streaming chat operations: list windows, replay a window's
 * transcript, delete a window, fetch the gateway-wide runner status.
 *
 * All four hit the same runtime-core surface that's served identically on
 * OpenClaw and the embedded local runtime, so the desktop main process
 * doesn't need to know which mode it's in.
 */

import type { ChatWindowMeta, RunnerStatus } from '@centraid/runtime-core';
import type { ChatHarnessConfig } from './types.js';
import { ChatHarnessError } from './chat-client.js';

export interface ChatHistoryResult {
  window: ChatWindowMeta;
  entries: unknown[];
}

export interface ChatWindowListResult {
  windows: ChatWindowMeta[];
}

export async function listChatWindows(
  config: ChatHarnessConfig,
  appId: string,
): Promise<ChatWindowListResult> {
  return call<ChatWindowListResult>(config, 'GET', `/centraid/${enc(appId)}/_chat/windows`);
}

export async function fetchChatHistory(
  config: ChatHarnessConfig,
  appId: string,
  windowId: string,
): Promise<ChatHistoryResult> {
  return call<ChatHistoryResult>(
    config,
    'GET',
    `/centraid/${enc(appId)}/_chat/windows/${enc(windowId)}/history`,
  );
}

export async function clearChatWindow(
  config: ChatHarnessConfig,
  appId: string,
  windowId: string,
): Promise<{ ok: boolean }> {
  return call<{ ok: boolean }>(
    config,
    'DELETE',
    `/centraid/${enc(appId)}/_chat/windows/${enc(windowId)}`,
  );
}

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
function enc(s: string): string {
  return encodeURIComponent(s);
}
