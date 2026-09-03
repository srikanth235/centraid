import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { notices, runFake, types, vaultToolContext } from "./test-fixtures.js";

interface VaultProbe {
  sawServer: boolean;
  serverName?: string;
  url?: string;
  unauthStatus?: number;
  serverInfoName?: string | null;
  tools?: string[];
  callText?: string | null;
  callIsError?: boolean | null;
}

async function stillListening(url: string): Promise<boolean> {
  try {
    await fetch(url, { method: "POST", body: "{}" });
    return true;
  } catch {
    return false;
  }
}

describe("backend.vault-tools", () => {
  test("vault tools reach the harness through the loopback MCP server", async () => {
    const dir = await tempDir("acp-vault-");
    const mcpMarker = path.join(dir, "mcp");
    const vaultMarker = path.join(dir, "vault");
    const ctx = vaultToolContext();

    const { events } = await runFake({
      extraArgs: [
        "--mode=vault",
        "--mcp-http",
        `--mcp-marker=${mcpMarker}`,
        `--vault-marker=${vaultMarker}`,
      ],
      toolContext: ctx,
    });

    const advertised = JSON.parse(
      await fs.readFile(mcpMarker, "utf8")
    ) as Array<{
      type: string;
      name: string;
      url: string;
      headers: Array<{ name: string; value: string }>;
    }>;
    expect(advertised).toHaveLength(1);
    expect(advertised[0]?.type).toBe("http");
    expect(advertised[0]?.name).toBe("centraid");
    expect(advertised[0]?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/u);
    expect(advertised[0]?.headers[0]?.name).toBe("Authorization");
    expect(advertised[0]?.headers[0]?.value).toMatch(/^Bearer [0-9a-f]{64}$/u);

    const probe = JSON.parse(
      await fs.readFile(vaultMarker, "utf8")
    ) as VaultProbe;
    expect(probe.unauthStatus).toBe(401);
    expect(probe.serverInfoName).toBe("centraid");
    expect(probe.tools).toStrictEqual(["vault_sql"]);
    expect(probe.callIsError).toBe(false);
    expect(probe.callText).toBe(JSON.stringify({ rows: [{ one: 1 }] }));

    expect(ctx.calls).toStrictEqual([{ sql: "SELECT 1" }]);

    const start = events.find((e) => e.type === "tool.start");
    expect(start && start.type === "tool.start" && start.toolName).toBe(
      "vault_sql"
    );
    expect(start && start.type === "tool.start" && start.sql).toBe("SELECT 1");
    const result = events.find((e) => e.type === "tool.result");
    expect(result && result.type === "tool.result" && result.ok).toBe(true);
    expect(
      result && result.type === "tool.result" && result.result
    ).toStrictEqual({
      rows: [{ one: 1 }],
    });

    await expect(stillListening(String(probe.url))).resolves.toBe(false);
  });

  test("vault_invoke / vault_content are advertised only when the turn carries them", async () => {
    const dir = await tempDir("acp-vault-");
    const vaultMarker = path.join(dir, "vault");
    await runFake({
      extraArgs: [
        "--mode=vault",
        "--mcp-http",
        `--vault-marker=${vaultMarker}`,
      ],
      toolContext: vaultToolContext({
        vaultInvoke: () => Promise.resolve({ outcome: "ok" }),
        vaultContent: () => Promise.resolve({ text: "hi" }),
      }),
    });
    const probe = JSON.parse(
      await fs.readFile(vaultMarker, "utf8")
    ) as VaultProbe;
    expect(probe.tools).toStrictEqual([
      "vault_sql",
      "vault_invoke",
      "vault_content",
    ]);
  });

  test("a harness that streams the MCP call itself is not double-rendered", async () => {
    const dir = await tempDir("acp-vault-");
    const vaultMarker = path.join(dir, "vault");
    const { events } = await runFake({
      extraArgs: [
        "--mode=vault",
        "--mcp-http",
        "--mcp-announce",
        `--vault-marker=${vaultMarker}`,
      ],
      toolContext: vaultToolContext(),
    });
    expect(events.filter((e) => e.type === "tool.start")).toHaveLength(1);
    expect(events.filter((e) => e.type === "tool.result")).toHaveLength(1);
    const start = events.find((e) => e.type === "tool.start");
    expect(start && start.type === "tool.start" && start.toolName).toBe(
      "mcp__centraid__vault_sql"
    );
  });

  test("a harness with no HTTP MCP support gets a stdio vault bridge instead of silence", async () => {
    const dir = await tempDir("acp-vault-");
    const mcpMarker = path.join(dir, "mcp");
    const { events } = await runFake({
      extraArgs: ["--mode=normal", `--mcp-marker=${mcpMarker}`],
      toolContext: vaultToolContext(),
    });
    const advertised = JSON.parse(
      await fs.readFile(mcpMarker, "utf8")
    ) as Array<{
      name?: string;
      command?: string;
      type?: string;
    }>;
    expect(advertised).toHaveLength(1);
    expect(advertised[0]?.name).toBe("centraid");
    expect(advertised[0]?.type).toBeUndefined();
    expect(advertised[0]?.command).toBeTruthy();
    expect(notices(events)).toContain("vault_tools_stdio");
    expect(notices(events)).not.toContain("vault_tools_unavailable");
  });

  test("a turn with no toolContext advertises no MCP server at all", async () => {
    const dir = await tempDir("acp-vault-");
    const mcpMarker = path.join(dir, "mcp");
    const { events } = await runFake({
      extraArgs: ["--mode=normal", "--mcp-http", `--mcp-marker=${mcpMarker}`],
    });
    expect(JSON.parse(await fs.readFile(mcpMarker, "utf8"))).toStrictEqual([]);
    expect(notices(events)).not.toContain("vault_tools_unavailable");
  });

  test("aborting mid-tool-call still closes the vault endpoint", async () => {
    const dir = await tempDir("acp-vault-");
    const vaultMarker = path.join(dir, "vault");
    const mcpMarker = path.join(dir, "mcp");
    const { events } = await runFake({
      extraArgs: [
        "--mode=vault",
        "--mcp-http",
        `--mcp-marker=${mcpMarker}`,
        `--vault-marker=${vaultMarker}`,
      ],
      toolContext: vaultToolContext(),
      abortOn: (e) => e.type === "tool.start",
    });
    expect(types(events)).toContain("aborted");

    const advertised = JSON.parse(
      await fs.readFile(mcpMarker, "utf8")
    ) as Array<{ url: string }>;
    await expect(stillListening(String(advertised[0]?.url))).resolves.toBe(
      false
    );
  });
});
