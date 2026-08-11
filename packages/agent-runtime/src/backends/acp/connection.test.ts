// The SDK-backed wire layer, driven over a pair of in-memory pipes instead of
// a real child: frame validation, the declined-by-default server→client
// surface, and the turn sink's attach/release lifetime.

import { PassThrough } from "node:stream";

import { RequestError } from "@agentclientprotocol/sdk";
import { describe, expect, test } from "vitest";

import { AcpFrameError, connectHarness } from "./connection.ts";
import type { HarnessConnection } from "./connection.ts";

interface Pipes {
  conn: HarnessConnection;
  /** Frames the agent writes to us. */
  fromAgent: (line: string) => void;
  /** Frames we wrote to the agent, parsed. */
  toAgent: () => Promise<Record<string, unknown>[]>;
  exit: () => void;
}

function pipes(): Pipes {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const listeners = new Map<string, (arg?: unknown) => void>();
  const child = {
    stdin,
    stdout,
    stderr,
    killed: false,
    kill: () => true,
    on: (event: string, listener: (arg?: unknown) => void) => {
      listeners.set(event, listener);
    },
  } as unknown as Parameters<typeof connectHarness>[0];
  const written: string[] = [];
  stdin.setEncoding("utf8");
  stdin.on("data", (chunk: string) => written.push(chunk));
  return {
    conn: connectHarness(child),
    fromAgent: (line) => stdout.write(line + "\n"),
    toAgent: async () => {
      // One macrotask is enough for the SDK's writer to drain into `stdin`.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      });
      return written
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    exit: () => listeners.get("exit")?.(),
  };
}

describe("connection suite", () => {
  test("a request resolves from the agent's response frame", async () => {
    const p = pipes();
    const answer = p.conn.request<{ sessionId: string }>("session/new", {
      cwd: "/tmp",
    });
    const [sent] = await p.toAgent();
    expect(sent?.method).toBe("session/new");
    p.fromAgent(
      JSON.stringify({
        jsonrpc: "2.0",
        id: sent?.id,
        result: { sessionId: "sess-1" },
      })
    );
    expect((await answer).sessionId).toBe("sess-1");
  });

  test("a JSON-RPC error keeps its code as a RequestError", async () => {
    const p = pipes();
    const answer = p.conn.request("session/new", { cwd: "/tmp" });
    const [sent] = await p.toAgent();
    p.fromAgent(
      JSON.stringify({
        jsonrpc: "2.0",
        id: sent?.id,
        error: { code: -32000, message: "Authentication required" },
      })
    );
    await expect(answer).rejects.toBeInstanceOf(RequestError);
    await expect(answer).rejects.toMatchObject({ code: -32000 });
  });

  test("a malformed frame fails the pending request instead of hanging", async () => {
    const p = pipes();
    const answer = p.conn.request("initialize", {});
    await p.toAgent();
    p.fromAgent('{"jsonrpc":"2.0","id":0,"result":');
    await expect(answer).rejects.toBeInstanceOf(AcpFrameError);
    expect(p.conn.isClosed()).toBe(true);
  });

  test("a frame-shaped line that is not JSON-RPC fails the same way", async () => {
    const p = pipes();
    const answer = p.conn.request("initialize", {});
    await p.toAgent();
    p.fromAgent('{"hello":"world"}');
    await expect(answer).rejects.toBeInstanceOf(AcpFrameError);
  });

  test("non-frame stdout chatter is ignored", async () => {
    const p = pipes();
    const answer = p.conn.request("initialize", {});
    const [sent] = await p.toAgent();
    p.fromAgent("starting up, this is not a frame");
    p.fromAgent(JSON.stringify({ jsonrpc: "2.0", id: sent?.id, result: {} }));
    await expect(answer).resolves.toStrictEqual({});
  });

  test("with no sink attached, a server request is declined", async () => {
    const p = pipes();
    p.fromAgent(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "session/request_permission",
        params: { sessionId: "s", toolCall: {}, options: [] },
      })
    );
    const frames = await p.toAgent();
    const reply = frames.find((frame) => frame.id === 7);
    expect(reply?.error).toMatchObject({
      code: RequestError.methodNotFound("x").code,
    });
  });

  test("an attached sink answers permissions and sees session updates", async () => {
    const p = pipes();
    const updates: unknown[] = [];
    let calls = 0;
    p.conn.attach({
      onFrame: () => {
        calls += 1;
      },
      onPermissionRequest: () => ({
        outcome: { outcome: "selected", optionId: "allow" },
      }),
      onSessionUpdate: (params) => updates.push(params),
    });
    p.fromAgent(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "session/request_permission",
        params: { sessionId: "s", toolCall: {}, options: [] },
      })
    );
    p.fromAgent(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s", update: { sessionUpdate: "vendor_extra" } },
      })
    );
    const frames = await p.toAgent();
    expect(frames.find((frame) => frame.id === 3)?.result).toStrictEqual({
      outcome: { outcome: "selected", optionId: "allow" },
    });
    // Vendor variants the generated schema rejects still reach the normalizer.
    expect(updates).toHaveLength(1);
    expect(calls).toBe(2);
  });

  test("releasing the sink stops late frames reaching a finished turn", async () => {
    const p = pipes();
    const updates: unknown[] = [];
    const release = p.conn.attach({
      onSessionUpdate: (params) => updates.push(params),
    });
    release();
    p.fromAgent(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s", update: { sessionUpdate: "plan" } },
      })
    );
    await p.toAgent();
    expect(updates).toStrictEqual([]);
  });

  test("a child exit rejects in-flight work with an exit-classifiable cause", async () => {
    const p = pipes();
    const answer = p.conn.request("initialize", {});
    await p.toAgent();
    p.exit();
    await expect(answer).rejects.toThrow(/exited/u);
    expect(p.conn.isClosed()).toBe(true);
  });
});
