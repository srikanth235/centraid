import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { startMockLlmServer, type StagedTurn } from './mock-llm-server.js';

async function withServer<T>(
  fn: (server: Awaited<ReturnType<typeof startMockLlmServer>>) => Promise<T>,
  opts: Parameters<typeof startMockLlmServer>[0] = {},
): Promise<T> {
  const server = await startMockLlmServer(opts);
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

describe('mock-llm-server: bearer auth', () => {
  it('rejects requests without a bearer token (401)', async () => {
    await withServer(async (server) => {
      const res = await fetch(`${server.baseUrl}/messages`, { method: 'POST', body: '{}' });
      assert.equal(res.status, 401);
    });
  });

  it('rejects unknown dispatch ids (403)', async () => {
    await withServer(async (server) => {
      const res = await fetch(`${server.baseUrl}/messages`, {
        method: 'POST',
        headers: { authorization: 'Bearer centraid-mock-not-a-real-id' },
        body: '{}',
      });
      assert.equal(res.status, 403);
    });
  });

  it('serves GET /v1/models without auth (preflight)', async () => {
    await withServer(async (server) => {
      const res = await fetch(`${server.baseUrl}/models`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { data: Array<{ id: string }> };
      assert.equal(body.data.length, 1);
    });
  });
});

describe('mock-llm-server: stage + serve', () => {
  it('parks a request with no staged turn and releases it when one is staged (issue #166)', async () => {
    await withServer(async (server) => {
      const { dispatchId, bearerToken } = server.mintDispatchToken();
      // Fire the request BEFORE staging — the persistent session parks it
      // instead of 503-ing, then `stageTurn` releases it.
      const resPromise = fetch(`${server.baseUrl}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearerToken}`, accept: 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      });
      // Give the request time to land + park, then stage the turn.
      await new Promise((resolve) => setTimeout(resolve, 50));
      server.stageTurn(dispatchId, { text: 'released', stopReason: 'end_turn' });
      const res = await resPromise;
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.match(text, /"text":"released"/);
    });
  });

  it('endDispatch releases a parked request with a benign end_turn (issue #166)', async () => {
    await withServer(async (server) => {
      const { dispatchId, bearerToken } = server.mintDispatchToken();
      const resPromise = fetch(`${server.baseUrl}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearerToken}`, accept: 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      server.endDispatch(dispatchId);
      const res = await resPromise;
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.match(text, /"stop_reason":"end_turn"/);
    });
  });

  it('serves an Anthropic-style streaming response for a tool_use turn', async () => {
    await withServer(async (server) => {
      const { dispatchId, bearerToken } = server.mintDispatchToken();
      const staged: StagedTurn = {
        toolUses: [{ id: 'toolu_abc', name: 'github.list_pull_requests', input: { repo: 'foo' } }],
        stopReason: 'tool_use',
      };
      server.stageTurn(dispatchId, staged);
      const res = await fetch(`${server.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearerToken}`,
          accept: 'text/event-stream',
        },
        body: JSON.stringify({ messages: [{ role: 'user', content: '<<<centraid:foo:bar>>>' }] }),
      });
      assert.equal(res.status, 200);
      const text = await res.text();
      // Frame-level checks: SSE events should include message_start,
      // a tool_use content_block, and message_stop.
      assert.match(text, /event: message_start/);
      assert.match(text, /"type":"tool_use"/);
      assert.match(text, /"name":"github.list_pull_requests"/);
      assert.match(text, /"id":"toolu_abc"/);
      assert.match(text, /"stop_reason":"tool_use"/);
      assert.match(text, /event: message_stop/);
    });
  });

  it('fires onToolStart with the per-call tool_uses when a tool turn is served', async () => {
    const starts: Array<{ dispatchId: string; toolUses: Array<{ id: string; name: string }> }> = [];
    await withServer(
      async (server) => {
        const { dispatchId, bearerToken } = server.mintDispatchToken();
        server.stageTurn(dispatchId, {
          toolUses: [
            { id: 'toolu_a', name: 'mailer.send', input: {} },
            { id: 'toolu_b', name: 'github.list', input: {} },
          ],
          stopReason: 'tool_use',
        });
        await fetch(`${server.baseUrl}/messages`, {
          method: 'POST',
          headers: { authorization: `Bearer ${bearerToken}`, accept: 'text/event-stream' },
          body: JSON.stringify({ messages: [{ role: 'user', content: '<<<centraid:foo:bar>>>' }] }),
        });
        assert.equal(starts.length, 1);
        assert.equal(starts[0]!.dispatchId, dispatchId);
        assert.deepEqual(starts[0]!.toolUses, [
          { id: 'toolu_a', name: 'mailer.send' },
          { id: 'toolu_b', name: 'github.list' },
        ]);
      },
      { onToolStart: (dispatchId, toolUses) => starts.push({ dispatchId, toolUses }) },
    );
  });

  it('does not fire onToolStart for a text-only (no tool_use) turn', async () => {
    let fired = false;
    await withServer(
      async (server) => {
        const { dispatchId, bearerToken } = server.mintDispatchToken();
        server.stageTurn(dispatchId, { text: 'done', stopReason: 'end_turn' });
        await fetch(`${server.baseUrl}/messages`, {
          method: 'POST',
          headers: { authorization: `Bearer ${bearerToken}`, accept: 'text/event-stream' },
          body: JSON.stringify({ messages: [{ role: 'user', content: '<<<centraid:foo:bar>>>' }] }),
        });
        assert.equal(fired, false);
      },
      { onToolStart: () => (fired = true) },
    );
  });

  it('serves an OpenAI-style streaming response for a tool_use turn', async () => {
    await withServer(async (server) => {
      const { dispatchId, bearerToken } = server.mintDispatchToken();
      server.stageTurn(dispatchId, {
        toolUses: [{ id: 'call_xyz', name: 'github.list_issues', input: { state: 'open' } }],
        stopReason: 'tool_use',
      });
      const res = await fetch(`${server.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearerToken}`,
          accept: 'text/event-stream',
        },
        body: JSON.stringify({
          model: 'centraid-mock-run-automation',
          messages: [{ role: 'user', content: '<<<centraid:foo:bar>>>' }],
          stream: true,
        }),
      });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.match(text, /chat\.completion\.chunk/);
      assert.match(text, /tool_calls/);
      assert.match(text, /"id":"call_xyz"/);
      assert.match(text, /github\.list_issues/);
      assert.match(text, /"finish_reason":"tool_calls"/);
      assert.match(text, /\[DONE\]/);
    });
  });

  it('serves an OpenAI Responses streaming response for a tool_use turn', async () => {
    await withServer(async (server) => {
      const { dispatchId, bearerToken } = server.mintDispatchToken();
      server.stageTurn(dispatchId, {
        toolUses: [{ id: 'call_resp', name: 'exec_command', input: { cmd: 'ls' } }],
        stopReason: 'tool_use',
      });
      const res = await fetch(`${server.baseUrl}/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearerToken}`, accept: 'text/event-stream' },
        body: JSON.stringify({
          model: 'centraid-mock-run-automation',
          input: [{ type: 'message', role: 'user', content: 'go' }],
          stream: true,
        }),
      });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.match(text, /event: response\.created/);
      assert.match(text, /"type":"function_call"/);
      assert.match(text, /"name":"exec_command"/);
      assert.match(text, /"call_id":"call_resp"/);
      assert.match(text, /event: response\.completed/);
    });
  });

  it('serves an end_turn ack with assistant text', async () => {
    await withServer(async (server) => {
      const { dispatchId, bearerToken } = server.mintDispatchToken();
      server.stageTurn(dispatchId, { text: 'ok', stopReason: 'end_turn' });
      const res = await fetch(`${server.baseUrl}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearerToken}` },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'ack' }] }),
      });
      const text = await res.text();
      assert.match(text, /"text":"ok"/);
      assert.match(text, /"stop_reason":"end_turn"/);
    });
  });

  it('rejects stageTurn when an earlier turn is still pending', async () => {
    await withServer(async (server) => {
      const { dispatchId } = server.mintDispatchToken();
      server.stageTurn(dispatchId, { text: 'a', stopReason: 'end_turn' });
      assert.throws(
        () => server.stageTurn(dispatchId, { text: 'b', stopReason: 'end_turn' }),
        /already staged/,
      );
      server.clearStaged(dispatchId);
      // After clear, restaging is fine.
      server.stageTurn(dispatchId, { text: 'b', stopReason: 'end_turn' });
    });
  });
});

describe('mock-llm-server: tool_result capture', () => {
  it('routes Anthropic-style tool_result blocks to onToolResults', async () => {
    const captured: Array<{ dispatchId: string; id: string; content: string; isError: boolean }> =
      [];
    await withServer(
      async (server) => {
        const { dispatchId, bearerToken } = server.mintDispatchToken();
        server.stageTurn(dispatchId, { text: 'ok', stopReason: 'end_turn' });
        await fetch(`${server.baseUrl}/messages`, {
          method: 'POST',
          headers: { authorization: `Bearer ${bearerToken}` },
          body: JSON.stringify({
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'toolu_abc',
                    content: 'result text here',
                    is_error: false,
                  },
                ],
              },
            ],
          }),
        });
        assert.equal(captured.length, 1);
        assert.equal(captured[0]!.id, 'toolu_abc');
        assert.equal(captured[0]!.content, 'result text here');
        assert.equal(captured[0]!.isError, false);
      },
      {
        onToolResults: (dispatchId, results) => {
          for (const r of results) captured.push({ dispatchId, ...r });
        },
      },
    );
  });

  it('routes OpenAI Responses function_call_output items to onToolResults', async () => {
    const captured: Array<{ id: string; content: string }> = [];
    await withServer(
      async (server) => {
        const { dispatchId, bearerToken } = server.mintDispatchToken();
        server.stageTurn(dispatchId, { text: 'ok', stopReason: 'end_turn' });
        await fetch(`${server.baseUrl}/responses`, {
          method: 'POST',
          headers: { authorization: `Bearer ${bearerToken}` },
          body: JSON.stringify({
            input: [
              { type: 'message', role: 'user', content: 'go' },
              { type: 'function_call', call_id: 'call_resp', name: 'exec_command' },
              { type: 'function_call_output', call_id: 'call_resp', output: 'resp output' },
            ],
          }),
        });
        assert.equal(captured.length, 1);
        assert.equal(captured[0]!.id, 'call_resp');
        assert.equal(captured[0]!.content, 'resp output');
      },
      {
        onToolResults: (_dispatchId, results) => {
          for (const r of results) captured.push(r);
        },
      },
    );
  });

  it('surfaces the raw request body via onRequest (tool-enumeration probe)', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    await withServer(
      async (server) => {
        const { dispatchId, bearerToken } = server.mintDispatchToken();
        server.stageTurn(dispatchId, { text: 'ok', stopReason: 'end_turn' });
        await fetch(`${server.baseUrl}/responses`, {
          method: 'POST',
          headers: { authorization: `Bearer ${bearerToken}` },
          body: JSON.stringify({
            input: [{ type: 'message', role: 'user', content: 'go' }],
            tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object' } }],
          }),
        });
        assert.equal(bodies.length, 1);
        const tools = bodies[0]!.tools as Array<{ name: string }>;
        assert.equal(tools[0]!.name, 'exec_command');
      },
      {
        onRequest: (_dispatchId, body) => {
          bodies.push(body);
        },
      },
    );
  });

  it('routes OpenAI-style role=tool messages to onToolResults', async () => {
    const captured: Array<{ id: string; content: string }> = [];
    await withServer(
      async (server) => {
        const { dispatchId, bearerToken } = server.mintDispatchToken();
        server.stageTurn(dispatchId, { text: 'ok', stopReason: 'end_turn' });
        await fetch(`${server.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${bearerToken}` },
          body: JSON.stringify({
            messages: [
              { role: 'user', content: 'go' },
              { role: 'assistant', tool_calls: [{ id: 'call_xyz' }] },
              { role: 'tool', tool_call_id: 'call_xyz', content: 'tool output' },
            ],
          }),
        });
        assert.equal(captured.length, 1);
        assert.equal(captured[0]!.id, 'call_xyz');
        assert.equal(captured[0]!.content, 'tool output');
      },
      {
        onToolResults: (_dispatchId, results) => {
          for (const r of results) captured.push(r);
        },
      },
    );
  });
});
