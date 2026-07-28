/**
 * Branch-depth tests for packages/cli `main` (issue #545 B10):
 * unknown verb, missing --url/token paths, non-2xx health/list, --help/--version.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

import { main } from "./cli.ts";

describe("cli.branches", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function runCli(
    argv: string[],
    env: Record<string, string | undefined> = {}
  ): Promise<{ stdout: string; stderr: string; code: number | undefined }> {
    const out: string[] = [];
    const err: string[] = [];
    const writeOut = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((c) => {
        out.push(String(c));
        return true;
      });
    const writeErr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((c) => {
        err.push(String(c));
        return true;
      });
    let code: number | undefined;
    const exit = vi.spyOn(process, "exit").mockImplementation(((c?: number) => {
      code = c ?? 0;
      throw new Error(`__exit_${code}`);
    }) as never);

    const prev: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
      prev[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // Clear token env unless the test supplies it.
    if (!("CENTRAID_TOKEN" in env)) {
      prev.CENTRAID_TOKEN = process.env.CENTRAID_TOKEN;
      delete process.env.CENTRAID_TOKEN;
    }
    if (!("CENTRAID_GATEWAY_TOKEN" in env)) {
      prev.CENTRAID_GATEWAY_TOKEN = process.env.CENTRAID_GATEWAY_TOKEN;
      delete process.env.CENTRAID_GATEWAY_TOKEN;
    }

    try {
      await main(argv);
    } catch (e) {
      if (!(e instanceof Error) || !e.message.startsWith("__exit_")) throw e;
    } finally {
      writeOut.mockRestore();
      writeErr.mockRestore();
      exit.mockRestore();
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    return { stdout: out.join(""), stderr: err.join(""), code };
  }

  test("missing command and unknown command exit 2 with usage / error", async () => {
    const empty = await runCli([]);
    expect(empty.code).toBe(2);
    expect(empty.stderr).toMatch(/Usage:/u);

    const unknown = await runCli(["stream", "--url", "http://x"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toMatch(/unknown command 'stream'/u);
  });

  test("--url is required", async () => {
    const r = await runCli(["status"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--url is required/u);
  });

  test("--help and --version short-circuit", async () => {
    const help = await runCli(["--help"]);
    expect(help.code).toBe(2);
    expect(help.stderr).toMatch(/Usage:/u);

    const ver = await runCli(["--version"]);
    expect(ver.code).toBe(0);
    expect(ver.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/u);
  });

  // Test double: only the four members the CLI reads. The cast is what makes
  // the double assignable where a real Response is expected.
  function jsonResponse(status: number, body: unknown): Response {
    const text = body === undefined ? "" : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => text,
    } as unknown as Response;
  }

  test("health fails on non-2xx; list fails on 401 and other non-2xx", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/health"))
          return jsonResponse(503, { error: "down" });
        if (url.includes("/_apps"))
          return jsonResponse(401, { error: "unauthorized" });
        return jsonResponse(200, {
          version: "0.1.0",
          protocolVersion: 2,
          minSupportedProtocol: 2,
        });
      }
    );
    vi.stubGlobal("fetch", fetchImpl);

    const health = await runCli([
      "health",
      "--url",
      "http://gw",
      "--token",
      "t",
    ]);
    expect(health.code).toBe(1);
    expect(health.stderr).toMatch(/health HTTP 503/u);

    const list401 = await runCli([
      "list",
      "--url",
      "http://gw",
      "--token",
      "t",
    ]);
    expect(list401.code).toBe(1);
    expect(list401.stderr).toMatch(/unauthorized/u);

    fetchImpl.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/_apps")) return jsonResponse(500, {});
      return jsonResponse(200, {});
    });
    const list500 = await runCli([
      "list",
      "--url",
      "http://gw",
      "--token",
      "t",
    ]);
    expect(list500.code).toBe(1);
    expect(list500.stderr).toMatch(/list HTTP 500/u);
  });

  test("status fails when handshake refuses protocol", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          version: "9.0.0",
          protocolVersion: 99,
          minSupportedProtocol: 99,
        })
      )
    );
    const r = await runCli(["status", "--url", "http://gw", "--token", "t"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/protocol/u);
  });
});
