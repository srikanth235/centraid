/*
 * Vault MCP client for the scripted fake ACP harness. `--mode=vault` and
 * `--mode=vault-parity` dial the loopback server advertised at session/new.
 */

import { writeFileSync } from "node:fs";

export interface FakeAcpIo {
  update: (sessionId: string, payload: Record<string, unknown>) => void;
  respond: (id: string | number | null | undefined, result: unknown) => void;
  requestPermission: (
    sessionId: string,
    toolCallId: string
  ) => Promise<unknown>;
}

export interface AdvertisedMcpServer {
  type?: string;
  name?: string;
  url?: string;
  command?: string;
  headers?: { name: string; value: string }[];
}

export interface VaultHarnessOptions {
  io: FakeAcpIo;
  vaultMarker: string | undefined;
  mcpAnnounce: boolean;
}

const BLUEPRINT_INVOKE_PLAN = [
  {
    blueprint: "photos",
    command: "media.create_album",
    input: { title: "Harness parity album" },
  },
  {
    blueprint: "docs",
    command: "core.create_folder",
    input: { name: "Harness parity" },
  },
  {
    blueprint: "agenda",
    command: "schedule.propose_event",
    input: {
      summary: "Harness parity event",
      dtstart: "2026-08-03T09:00:00+05:30",
      dtend: "2026-08-03T09:30:00+05:30",
      start_tz: "Asia/Kolkata",
      end_tz: "Asia/Kolkata",
      calendar_id: "calendar-harness-parity",
    },
  },
  {
    blueprint: "tasks",
    command: "schedule.add_task",
    input: { title: "Harness parity task" },
  },
  {
    blueprint: "people",
    command: "people.add_person",
    input: { display_name: "Harness Parity", cadence_days: 30 },
  },
  {
    blueprint: "notes",
    command: "knowledge.create_note",
    input: {
      title: "Harness parity note",
      body_text: "Created through vault_invoke.",
      format: "plain",
    },
  },
  {
    blueprint: "tally",
    command: "tally.create_group",
    input: { name: "Harness parity", icon: "🧭", member_ids: [] },
  },
  {
    blueprint: "locker",
    command: "locker.purge_item",
    input: { item_id: "locker-harness-parity" },
  },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asServer(value: unknown): AdvertisedMcpServer | undefined {
  if (!isRecord(value)) return undefined;
  const type = typeof value.type === "string" ? value.type : undefined;
  const name = typeof value.name === "string" ? value.name : undefined;
  const url = typeof value.url === "string" ? value.url : undefined;
  const command = typeof value.command === "string" ? value.command : undefined;
  const headers = Array.isArray(value.headers)
    ? value.headers.flatMap((header) => {
        if (!isRecord(header)) return [];
        if (typeof header.name !== "string" || typeof header.value !== "string")
          return [];
        return [{ name: header.name, value: header.value }];
      })
    : undefined;
  return { type, name, url, command, headers };
}

export function pickMcpServer(list: unknown): AdvertisedMcpServer | undefined {
  const arr = Array.isArray(list) ? list : [];
  const parsed = arr.flatMap((item) => {
    const server = asServer(item);
    return server ? [server] : [];
  });
  return (
    parsed.find((server) => server.type === "http") ??
    parsed.find((server) => !server.type && server.command)
  );
}

function toolNames(body: unknown): string[] {
  if (!isRecord(body) || !isRecord(body.result)) return [];
  const tools = body.result.tools;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    if (!isRecord(tool) || typeof tool.name !== "string") return [];
    return [tool.name];
  });
}

function callText(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.result)) return null;
  const content = body.result.content;
  if (!Array.isArray(content) || !isRecord(content[0])) return null;
  return typeof content[0].text === "string" ? content[0].text : null;
}

function callIsError(body: unknown): boolean | null {
  if (!isRecord(body) || !isRecord(body.result)) return null;
  const flag = body.result.isError;
  return typeof flag === "boolean" ? flag : null;
}

function serverInfoName(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.result)) return null;
  const info = body.result.serverInfo;
  if (!isRecord(info) || typeof info.name !== "string") return null;
  return info.name;
}

export function createVaultSession(opts: VaultHarnessOptions): {
  setMcpServers: (list: unknown) => void;
  runVaultPrompt: (
    reqId: string | number | null | undefined,
    sessionId: string
  ) => Promise<void>;
  runVaultParityPrompt: (
    reqId: string | number | null | undefined,
    sessionId: string
  ) => Promise<void>;
} {
  let mcpServer: AdvertisedMcpServer | undefined;
  let mcpReqId = 0;

  async function mcpCall(
    method: string,
    params: Record<string, unknown>,
    { auth = true } = {}
  ): Promise<{ status: number; body: unknown }> {
    if (!mcpServer?.url) return { status: 0, body: null };
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (auth) {
      for (const header of mcpServer.headers ?? [])
        headers[header.name] = header.value;
    }
    const res = await fetch(mcpServer.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: ++mcpReqId, method, params }),
    });
    const body: unknown = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  return {
    setMcpServers(list: unknown) {
      mcpServer = pickMcpServer(list);
    },
    async runVaultPrompt(reqId, sessionId) {
      const out: Record<string, unknown> = { sawServer: Boolean(mcpServer) };
      if (mcpServer) {
        out.serverName = mcpServer.name;
        out.url = mcpServer.url;

        out.unauthStatus = (
          await mcpCall("tools/list", {}, { auth: false })
        ).status;

        const init = await mcpCall("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "fake-mcp-client", version: "0.0.1" },
        });
        out.serverInfoName = serverInfoName(init.body);
        out.tools = toolNames((await mcpCall("tools/list", {})).body);

        if (opts.mcpAnnounce) {
          opts.io.update(sessionId, {
            sessionUpdate: "tool_call",
            toolCallId: "mcp-1",
            title: "mcp__centraid__vault_sql",
            kind: "other",
            status: "pending",
          });
          await opts.io.requestPermission(sessionId, "mcp-1");
        }

        const call = await mcpCall("tools/call", {
          name: "vault_sql",
          arguments: { sql: "SELECT 1" },
        });
        out.callText = callText(call.body);
        out.callIsError = callIsError(call.body);

        if (opts.mcpAnnounce) {
          opts.io.update(sessionId, {
            sessionUpdate: "tool_call_update",
            toolCallId: "mcp-1",
            status: "completed",
            rawOutput: { ok: true },
          });
        }
      }
      if (opts.vaultMarker)
        writeFileSync(opts.vaultMarker, JSON.stringify(out));

      opts.io.update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "vault done" },
      });
      opts.io.respond(reqId, { stopReason: "end_turn" });
    },
    async runVaultParityPrompt(reqId, sessionId) {
      const out: {
        sawServer: boolean;
        tools: string[];
        invocations: Array<{
          blueprint: string;
          command: string;
          isError: boolean | null;
          text: string | null;
        }>;
      } = { sawServer: Boolean(mcpServer), tools: [], invocations: [] };
      if (mcpServer) {
        await mcpCall("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "fake-mcp-client", version: "0.0.1" },
        });
        out.tools = toolNames((await mcpCall("tools/list", {})).body);

        out.invocations = await Promise.all(
          BLUEPRINT_INVOKE_PLAN.map(async (planned) => {
            const response = await mcpCall("tools/call", {
              name: "vault_invoke",
              arguments: { command: planned.command, input: planned.input },
            });
            return {
              blueprint: planned.blueprint,
              command: planned.command,
              isError: callIsError(response.body),
              text: callText(response.body),
            };
          })
        );
      }
      if (opts.vaultMarker)
        writeFileSync(opts.vaultMarker, JSON.stringify(out));
      opts.io.update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "blueprint parity done" },
      });
      opts.io.respond(reqId, { stopReason: "end_turn" });
    },
  };
}
