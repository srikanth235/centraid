/*
 * Streaming HTTP/SSE client for `POST /centraid/<appId>/_chat`.
 *
 * Posts the turn and returns an `AsyncIterable<ChatStreamEvent>` plus an
 * `abort()` handle. The harness consumer drives the iteration; once the
 * server's `end` frame lands (or the abort fires) the iterator finishes
 * cleanly.
 *
 * The wire format is the standard SSE shape — `event: <type>` line, then
 * `data: <json>` line, then a blank line. Heartbeats arrive as `: ping`
 * comment lines and are ignored.
 */

import type { ChatStreamEvent } from '@centraid/runtime-core';
import type { ChatHarnessConfig } from './types.js';

export interface OpenChatStreamOptions {
  config: ChatHarnessConfig;
  appId: string;
  /** Stable id per chat pane. The runtime pins one window to one transcript. */
  windowId: string;
  message: string;
  model?: string;
  thinking?: string;
  /** Optional idempotency key. Plumbed through to the runner. */
  idempotencyKey?: string;
  /** Caller-supplied abort signal. Closing the SSE connection is the
   *  documented way to interrupt an in-flight turn. */
  signal?: AbortSignal;
}

export interface ChatStreamHandle {
  /** Async iterator of typed events. Completes when the server emits `end`
   *  or the client aborts. */
  events: AsyncIterable<ChatStreamEvent>;
  /** Best-effort abort. The server treats client-disconnect as the abort
   *  signal; this just closes the fetch underlying the SSE response. */
  abort(): void;
}

/**
 * Open a streaming chat turn. Resolves once the SSE headers are received;
 * the caller iterates `handle.events` to consume the stream.
 */
export async function openChatStream(opts: OpenChatStreamOptions): Promise<ChatStreamHandle> {
  const url = `${trim(opts.config.gatewayUrl)}/centraid/${encodeURIComponent(opts.appId)}/_chat`;
  const controller = new AbortController();
  // Forward caller-side abort to our internal controller. The fetch
  // listens only on our controller's signal, so cancellations from either
  // end produce the same effect.
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
  };
  if (opts.config.gatewayToken) {
    headers.authorization = `Bearer ${opts.config.gatewayToken}`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    signal: controller.signal,
    body: JSON.stringify({
      windowId: opts.windowId,
      message: opts.message,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.thinking ? { thinking: opts.thinking } : {}),
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ChatHarnessError(`chat stream HTTP ${res.status}`, res.status, text);
  }
  if (!res.body) {
    throw new ChatHarnessError('chat stream missing body', res.status);
  }

  const reader = res.body.getReader();

  return {
    events: parseSseStream(reader),
    abort: () => controller.abort(),
  };
}

async function* parseSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncIterable<ChatStreamEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  // Per-event accumulator. SSE frames are separated by a blank line; until
  // we see one we're still building the same event.
  let eventName = '';
  let dataLines: string[] = [];

  const flush = (): ChatStreamEvent | undefined => {
    if (!eventName || dataLines.length === 0) {
      eventName = '';
      dataLines = [];
      return undefined;
    }
    if (eventName === 'end') {
      eventName = '';
      dataLines = [];
      return undefined;
    }
    let parsed: ChatStreamEvent | undefined;
    try {
      parsed = JSON.parse(dataLines.join('\n')) as ChatStreamEvent;
    } catch {
      parsed = undefined;
    }
    eventName = '';
    dataLines = [];
    return parsed;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        const tail = flush();
        if (tail) yield tail;
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      // Split on \n; keep the final partial line in `buffer`.
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line === '') {
          const out = flush();
          if (out) yield out;
        } else if (line.startsWith(':')) {
          // comment / heartbeat — ignore
        } else if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        nl = buffer.indexOf('\n');
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* swallow */
    }
  }
}

export class ChatHarnessError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'ChatHarnessError';
  }
}

function trim(url: string): string {
  return url.replace(/\/+$/, '');
}
