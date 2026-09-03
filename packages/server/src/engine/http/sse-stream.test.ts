import { createServer } from "node:http";
import type { Server } from "node:http";
import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { SseStream } from "./sse-stream.js";

let server: Server | undefined;

async function stalledClient(
  onStream: (stream: SseStream) => void
): Promise<{ overflowBytes: number | undefined; delivered: number }> {
  let overflowBytes: number | undefined;
  let delivered = 0;
  const done = new Promise<void>((resolve) => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const stream = new SseStream(res, {
        maxBufferedBytes: 64 * 1024,
        onOverflow: (bytes) => {
          overflowBytes = bytes;
        },
      });
      onStream(stream);
      const payload = "x".repeat(4096);
      for (let index = 0; index < 100_000; index++) {
        if (!stream.event("blob", payload)) break;
        delivered += 1;
      }
      resolve();
    });
  });
  await new Promise<void>((resolve) => {
    server!.listen(0, "127.0.0.1", resolve);
  });
  const port = (server!.address() as net.AddressInfo).port;
  const socket = net.connect(port, "127.0.0.1");
  socket.on("error", () => undefined);
  socket.pause();
  socket.write(`GET /stream HTTP/1.1\r\nHost: localhost\r\n\r\n`);
  await done;
  socket.destroy();
  return { overflowBytes, delivered };
}

describe(SseStream, () => {
  afterEach(async () => {
    const current = server;
    server = undefined;
    if (!current) return;
    await new Promise<void>((resolve) => {
      current.close(() => resolve());
    });
  });

  it("drops a client that stops reading instead of buffering it without bound", async () => {
    const { overflowBytes, delivered } = await stalledClient(() => undefined);
    expect(delivered).toBeLessThan(100_000);
    expect(overflowBytes).toBeDefined();
    expect(overflowBytes!).toBeLessThan(2 * 64 * 1024 + 8192);
  }, 20_000);

  it("reports itself closed after a drop, so callers stop feeding it", async () => {
    let observed: SseStream | undefined;
    await stalledClient((stream) => {
      observed = stream;
    });
    expect(observed?.droppedForBackpressure).toBe(true);
    expect(observed?.closed).toBe(true);
    expect(observed?.write("event: late\ndata: {}\n\n")).toBe(false);
  }, 20_000);

  it("delivers frames normally to a client that keeps up", async () => {
    const received: string[] = [];
    server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const stream = new SseStream(res);
      expect(stream.comment("connected")).toBe(true);
      expect(stream.event("change", '{"n":1}')).toBe(true);
      expect(stream.event("change", '{"n":2}')).toBe(true);
      stream.end();
    });
    await new Promise<void>((resolve) => {
      server!.listen(0, "127.0.0.1", resolve);
    });
    const port = (server!.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write("GET /stream HTTP/1.1\r\nHost: localhost\r\n\r\n");
      });
      socket.on("data", (chunk) => received.push(chunk.toString()));
      socket.on("end", resolve);
      socket.on("error", () => resolve());
    });
    const body = received.join("");
    expect(body).toContain(": connected\n\n");
    expect(body).toContain('event: change\ndata: {"n":1}\n\n');
    expect(body).toContain('event: change\ndata: {"n":2}\n\n');
  }, 20_000);
});
