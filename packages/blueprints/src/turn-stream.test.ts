/* oxlint-disable typescript-eslint/ban-ts-comment -- imports the untyped browser
   kit module; the package tsconfig has no DOM lib, so web globals (ReadableStream,
   TextEncoder) are runtime-real but invisible to tsc (see kit-smoke.test.ts). */
// @ts-nocheck — exercises the untyped browser kit module (plain JS + web
// globals) directly; see kit-smoke.test.ts for the same pattern.
// Unit tests for the shared SSE turn-stream parser (issue #420) — the ONE
// parser both chat surfaces drive their `_turn` streams through.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const PKG = path.resolve(import.meta.dirname, '..');
const url = pathToFileURL(path.resolve(PKG, 'kit/turn-stream.js')).href;
const { frameData, parseFrame, parseSseText, consumeSse } = await import(url);

// A gateway SSE frame carries both `event: <type>` and a JSON body with `type`.
const frame = (evt: unknown) =>
  `event: ${(evt as { type: string }).type}\ndata: ${JSON.stringify(evt)}`;

/** A ReadableStream that yields the given string chunks as UTF-8 bytes. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
}

describe('turn-stream frame parsing', () => {
  it('extracts concatenated data lines, tolerating "data:" and "data: "', () => {
    expect(frameData('event: x\ndata:{"a":1}')).toBe('{"a":1}');
    expect(frameData('data: {"a":1}')).toBe('{"a":1}');
  });

  it('parses a frame by the JSON `type`, ignoring heartbeats and the end frame', () => {
    expect(parseFrame(frame({ type: 'assistant.delta', delta: 'hi' }))).toEqual({
      type: 'assistant.delta',
      delta: 'hi',
    });
    expect(parseFrame(': ping')).toBeNull();
    expect(parseFrame('event: end\ndata: {}')).toBeNull(); // `{}` has no type
    expect(parseFrame('data: not json')).toBeNull();
  });

  it('parseSseText splits a whole blob into typed events', () => {
    const blob = [
      ': banner',
      frame({ type: 'assistant.start' }),
      frame({ type: 'assistant.delta', delta: 'a' }),
      frame({ type: 'final', text: 'a' }),
      'event: end\ndata: {}',
    ].join('\n\n');
    const types = parseSseText(blob).map((e: { type: string }) => e.type);
    expect(types).toEqual(['assistant.start', 'assistant.delta', 'final']);
  });
});

describe('consumeSse', () => {
  it('dispatches every event, reassembling frames split across chunks', async () => {
    const full =
      [
        ': banner',
        frame({ type: 'assistant.delta', delta: 'Hel' }),
        frame({ type: 'assistant.delta', delta: 'lo' }),
        frame({ type: 'final', text: 'Hello' }),
        'event: end\ndata: {}',
      ].join('\n\n') + '\n\n';
    // Split mid-frame to prove the internal buffer stitches partial frames.
    const mid = Math.floor(full.length / 2);
    const events: Array<{ type: string }> = [];
    await consumeSse(streamOf([full.slice(0, mid), full.slice(mid)]), (e) => events.push(e));
    expect(events.map((e) => e.type)).toEqual(['assistant.delta', 'assistant.delta', 'final']);
    expect(events[2]).toEqual({ type: 'final', text: 'Hello' });
  });

  it('stops cleanly on an aborted signal without throwing', async () => {
    const controller = new AbortController();
    controller.abort();
    const events: unknown[] = [];
    await expect(
      consumeSse(streamOf([frame({ type: 'final', text: 'x' }) + '\n\n']), (e) => events.push(e), {
        signal: controller.signal,
      }),
    ).resolves.toBeUndefined();
  });
});
