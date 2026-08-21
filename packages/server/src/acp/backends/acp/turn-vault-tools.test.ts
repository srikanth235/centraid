/**
 * Direct unit tests for startTurnVaultTools (issue #545 B11).
 */

import { afterEach, describe, expect, test, vi } from "vitest";

import type { TurnStreamEvent } from "@centraid/server/engine";

import { startTurnVaultTools } from "./turn-vault-tools.ts";
import {
  startVaultMcpServer,
  VAULT_MCP_SERVER_NAME,
} from "./vault-mcp-server.ts";

type VaultMcpServerModule = typeof import("./vault-mcp-server.ts");

// vitest hoists vi.mock above imports at run time.
vi.mock(import("./vault-mcp-server.ts"), async (importOriginal) => {
  const actual = await importOriginal<VaultMcpServerModule>();
  return {
    ...actual,
    startVaultMcpServer: vi.fn<typeof actual.startVaultMcpServer>(
      actual.startVaultMcpServer
    ),
  };
});

const handles: Array<{ close: () => Promise<void> }> = [];

describe("turn-vault-tools", () => {
  afterEach(async () => {
    const closeNext = async (): Promise<void> => {
      const h = handles.pop();
      if (!h) return;
      await h.close().catch(() => undefined);
      return closeNext();
    };
    await closeNext();
    vi.mocked(startVaultMcpServer).mockImplementation(
      (...args) =>
        (
          vi.importActual(
            "./vault-mcp-server.ts"
          ) as Promise<VaultMcpServerModule>
        ).then((m) => m.startVaultMcpServer(...args)) as never
    );
    // Reset to real implementation for subsequent tests.
    const real = await vi.importActual<VaultMcpServerModule>(
      "./vault-mcp-server.ts"
    );
    vi.mocked(startVaultMcpServer).mockImplementation(real.startVaultMcpServer);
  });

  function toolContext() {
    return {
      vaultSql: async () => ({ columns: [], rows: [] }),
      vaultInvoke: async () => ({ ok: true }),
    };
  }

  test("returns empty mcpServers when toolContext has no vaultSql", async () => {
    const events: TurnStreamEvent[] = [];
    const out = await startTurnVaultTools({
      toolContext: undefined,
      httpMcp: true,
      emit: (e) => events.push(e),
      harnessStreamsTool: () => false,
    });
    expect(out).toStrictEqual({ mcpServers: [] });
    expect(events).toStrictEqual([]);
  });

  test("httpMcp=true advertises the HTTP MCP server handle", async () => {
    const events: TurnStreamEvent[] = [];
    const out = await startTurnVaultTools({
      toolContext: toolContext() as never,
      httpMcp: true,
      emit: (e) => events.push(e),
      harnessStreamsTool: () => false,
    });
    if (out.handle) handles.push(out.handle);
    expect(out.transport).toBe("http");
    expect(out.mcpServers).toHaveLength(1);
    expect(out.mcpServers[0]).toMatchObject({ name: VAULT_MCP_SERVER_NAME });
    expect(out.handle?.server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+/u);
  });

  test("httpMcp=false bridges over stdio MCP and emits a notice", async () => {
    const events: TurnStreamEvent[] = [];
    const out = await startTurnVaultTools({
      toolContext: toolContext() as never,
      httpMcp: false,
      emit: (e) => events.push(e),
      harnessStreamsTool: () => false,
    });
    if (out.handle) handles.push(out.handle);
    expect(out.transport).toBe("stdio");
    const stdio = out.mcpServers[0] as {
      name: string;
      command: string;
      args: string[];
      env: { name: string; value: string }[];
    };
    expect(stdio.name).toBe(VAULT_MCP_SERVER_NAME);
    expect(stdio.command).toBe(process.execPath);
    expect(stdio.args[0]).toMatch(/vault-mcp-stdio-proxy\.mjs$/u);
    expect(stdio.env.some((e) => e.name === "CENTRAID_VAULT_MCP_URL")).toBe(
      true
    );
    expect(stdio.env.some((e) => e.name === "CENTRAID_VAULT_MCP_TOKEN")).toBe(
      true
    );
    expect(
      events.some((e) => e.type === "notice" && e.code === "vault_tools_stdio")
    ).toBe(true);
  });

  test("start failure emits vault_tools_unavailable and returns empty servers", async () => {
    vi.mocked(startVaultMcpServer).mockRejectedValueOnce(
      new Error("bind failed")
    );
    const events: TurnStreamEvent[] = [];
    const out = await startTurnVaultTools({
      toolContext: toolContext() as never,
      httpMcp: true,
      emit: (e) => events.push(e),
      harnessStreamsTool: () => false,
    });
    expect(out).toStrictEqual({ mcpServers: [] });
    expect(events).toStrictEqual([
      expect.objectContaining({
        type: "notice",
        level: "warn",
        code: "vault_tools_unavailable",
        message: expect.stringMatching(/bind failed/u),
      }),
    ]);
  });
});
