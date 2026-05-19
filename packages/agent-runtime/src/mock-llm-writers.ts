/**
 * On-wire response writers for the mock-LLM server. Split out from
 * `mock-llm-server.ts` so each file stays under the repo-hygiene
 * 500-line cap and the protocol details (Anthropic vs OpenAI vs
 * non-stream) are reviewable in isolation.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { StagedTurn } from './mock-llm-server.js';

const MODEL_ID = 'centraid-mock-run-automation';

function isStreamingRequested(req: IncomingMessage): boolean {
  // Both Anthropic and OpenAI accept a body-level `stream: true` flag.
  // The writer is called after the body has already been drained, so
  // peek the Accept header instead — `text/event-stream` reliably
  // signals streaming. Callers that need the non-stream form set
  // Accept: application/json explicitly. The default is streaming
  // because both CLIs we drive (claude -p stream-json, codex exec
  // --json) request it.
  const accept = req.headers.accept;
  if (typeof accept === 'string' && accept.includes('application/json')) return false;
  return true;
}

/**
 * Anthropic Messages response (POST /v1/messages). Streams a minimal
 * sequence both `claude -p --output-format stream-json` and the SDK's
 * tool-result back-half consume.
 */
export function writeAnthropicMessages(
  req: IncomingMessage,
  res: ServerResponse,
  turn: StagedTurn,
): void {
  if (!isStreamingRequested(req)) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(anthropicNonStreamBody(turn)));
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const messageId = `msg_${randomBytes(8).toString('hex')}`;
  const writeEvent = (event: string, data: unknown): void => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  writeEvent('message_start', {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: MODEL_ID,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  let blockIndex = 0;
  if (turn.text) {
    writeEvent('content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'text', text: '' },
    });
    writeEvent('content_block_delta', {
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'text_delta', text: turn.text },
    });
    writeEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex });
    blockIndex++;
  }
  for (const tu of turn.toolUses ?? []) {
    writeEvent('content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'tool_use', id: tu.id, name: tu.name, input: {} },
    });
    writeEvent('content_block_delta', {
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(tu.input ?? {}) },
    });
    writeEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex });
    blockIndex++;
  }
  writeEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: turn.stopReason, stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  writeEvent('message_stop', { type: 'message_stop' });
  res.end();
}

function anthropicNonStreamBody(turn: StagedTurn): Record<string, unknown> {
  const content: unknown[] = [];
  if (turn.text) content.push({ type: 'text', text: turn.text });
  for (const tu of turn.toolUses ?? []) {
    content.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input ?? {} });
  }
  return {
    id: `msg_${randomBytes(8).toString('hex')}`,
    type: 'message',
    role: 'assistant',
    model: MODEL_ID,
    content,
    stop_reason: turn.stopReason,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 1 },
  };
}

/**
 * OpenAI Chat Completions response (POST /v1/chat/completions). The
 * codex provider's `wire_api = "chat"` setting emits this shape with
 * function-style tool calls.
 */
export function writeOpenAiChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  turn: StagedTurn,
): void {
  const finishReason = turn.stopReason === 'tool_use' ? 'tool_calls' : 'stop';
  const toolCalls = (turn.toolUses ?? []).map((tu, idx) => ({
    index: idx,
    id: tu.id,
    type: 'function',
    function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) },
  }));

  if (!isStreamingRequested(req)) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: `chatcmpl-${randomBytes(8).toString('hex')}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: MODEL_ID,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: turn.text ?? '',
              ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            },
            finish_reason: finishReason,
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 },
      }),
    );
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const id = `chatcmpl-${randomBytes(8).toString('hex')}`;
  const created = Math.floor(Date.now() / 1000);
  const sendChunk = (delta: unknown, finish: string | null): void => {
    const payload = {
      id,
      object: 'chat.completion.chunk',
      created,
      model: MODEL_ID,
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  if (turn.text) sendChunk({ role: 'assistant', content: turn.text }, null);
  if (toolCalls.length > 0) sendChunk({ role: 'assistant', tool_calls: toolCalls }, null);
  sendChunk({}, finishReason);
  res.write('data: [DONE]\n\n');
  res.end();
}
