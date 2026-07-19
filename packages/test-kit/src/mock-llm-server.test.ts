import { describe, expect, it } from 'vitest';
import { startMockLlmServer, type StagedTurn } from '@centraid/mock-llm';

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
      expect(res.status).toBe(401);
    });
  });

  it('rejects unknown dispatch ids (403)', async () => {
    await withServer(async (server) => {
      const res = await fetch(`${server.baseUrl}/messages`, {
        method: 'POST',
        headers: { authorization: 'Bearer centraid-mock-not-a-real-id' },
        body: '{}',
      });
      expect(res.status).toBe(403);
    });
  });

  it('serves GET /v1/models without auth (preflight)', async () => {
    await withServer(async (server) => {
      const res = await fetch(`${server.baseUrl}/models`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ id: string }> };
      expect(body.data.length).toBe(1);
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
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toMatch(/"text":"released"/);
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
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toMatch(/"stop_reason":"end_turn"/);
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
      expect(res.status).toBe(200);
      const text = await res.text();
      // Frame-level checks: SSE events should include message_start,
      // a tool_use content_block, and message_stop.
      expect(text).toMatch(/event: message_start/);
      expect(text).toMatch(/"type":"tool_use"/);
      expect(text).toMatch(/"name":"github.list_pull_requests"/);
      expect(text).toMatch(/"id":"toolu_abc"/);
      expect(text).toMatch(/"stop_reason":"tool_use"/);
      expect(text).toMatch(/event: message_stop/);
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
        expect(starts.length).toBe(1);
        expect(starts[0]!.dispatchId).toBe(dispatchId);
        expect(starts[0]!.toolUses).toEqual([
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
        expect(fired).toBe(false);
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
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toMatch(/chat\.completion\.chunk/);
      expect(text).toMatch(/tool_calls/);
      expect(text).toMatch(/"id":"call_xyz"/);
      expect(text).toMatch(/github\.list_issues/);
      expect(text).toMatch(/"finish_reason":"tool_calls"/);
      expect(text).toMatch(/\[DONE\]/);
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
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toMatch(/event: response\.created/);
      expect(text).toMatch(/"type":"function_call"/);
      expect(text).toMatch(/"name":"exec_command"/);
      expect(text).toMatch(/"call_id":"call_resp"/);
      expect(text).toMatch(/event: response\.completed/);
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
      expect(text).toMatch(/"text":"ok"/);
      expect(text).toMatch(/"stop_reason":"end_turn"/);
    });
  });

  it('rejects stageTurn when an earlier turn is still pending', async () => {
    await withServer(async (server) => {
      const { dispatchId } = server.mintDispatchToken();
      server.stageTurn(dispatchId, { text: 'a', stopReason: 'end_turn' });
      expect(() => server.stageTurn(dispatchId, { text: 'b', stopReason: 'end_turn' })).toThrow(
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
        expect(captured.length).toBe(1);
        expect(captured[0]!.id).toBe('toolu_abc');
        expect(captured[0]!.content).toBe('result text here');
        expect(captured[0]!.isError).toBe(false);
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
        expect(captured.length).toBe(1);
        expect(captured[0]!.id).toBe('call_resp');
        expect(captured[0]!.content).toBe('resp output');
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
        expect(bodies.length).toBe(1);
        const tools = bodies[0]!.tools as Array<{ name: string }>;
        expect(tools[0]!.name).toBe('exec_command');
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
        expect(captured.length).toBe(1);
        expect(captured[0]!.id).toBe('call_xyz');
        expect(captured[0]!.content).toBe('tool output');
      },
      {
        onToolResults: (_dispatchId, results) => {
          for (const r of results) captured.push(r);
        },
      },
    );
  });
});
