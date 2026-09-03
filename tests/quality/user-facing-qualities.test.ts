// governance: allow-repo-hygiene file-size-limit (#679) the seven-quality contract is deliberately one cross-surface completeness suite so registry and matrix omissions cannot hide in independently selected shards
import { access, glob, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  ASSISTANT_APP_ID,
  ConversationHistoryStore,
} from "@centraid/server/engine";
import {
  isSealedValue,
  sealAad,
  sealValue,
  SEALED_COLUMNS,
  SEALED_ENFORCEMENT_POINTS,
  SEALED_LEAK_SURFACES,
  SEALED_PLACEHOLDER,
  VAULT_SQL_MAX_ROWS,
  buildAssistantContext,
  checkpointVault,
  createGateway,
  exportPortableVault,
  ensureConnection,
  readZipEntries,
  registerLockerCommands,
  stageCandidates,
  withReplicaSnapshot,
} from "@centraid/vault";

import {
  startVaultMcpServer,
  VAULT_MCP_TOOL_REGISTRY,
} from "../../packages/server/src/acp/backends/acp/vault-mcp-server.js";
import { runFire } from "../../packages/server/src/automation/fire/fire.js";
import {
  AUTOMATION_TRIGGER_KINDS,
  AUTOMATION_TRIGGER_REGISTRY,
} from "../../packages/server/src/automation/manifest/manifest.js";
import { HARNESS_KINDS } from "../../packages/server/src/engine/conversation/turn.js";
import { makeAssistantRouteHandler } from "../../packages/server/src/routes/assistant-routes.js";
import {
  assertRouteSecurityCoverage,
  ROUTE_SECURITY_REGISTRY,
} from "../../packages/server/src/routes/route-security.js";
import { buildGateway } from "../../packages/server/src/serve/build-gateway.js";
import { EXPECTED_HEALTH_COMPONENTS } from "../../packages/server/src/serve/health-registry.js";
import { openVaultPlane } from "../../packages/server/src/serve/vault-plane.js";
import { forEachSequentially } from "../../packages/test-kit/src/sequential.js";
import { tempDir } from "../../packages/test-kit/src/temp-dir.js";
import {
  seedYear3Vault,
  materializeYear3Fixture,
  year3FixtureCacheKey,
  year3VaultProfile,
} from "../../packages/test-kit/src/year3-vault.js";
import { createTestVault } from "../helpers/factories.js";

const root = path.resolve(import.meta.dirname, "../..");

const compareStrings = (left: string, right: string): number =>
  left.localeCompare(right);

async function json(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(root, file), "utf8")) as Record<
    string,
    unknown
  >;
}

async function globFiles(pattern: string): Promise<string[]> {
  const files: string[] = [];
  for await (const file of glob(pattern, { cwd: root })) files.push(file);
  return files;
}

const COPY_SCOPE = [
  "packages/client/src/**/*.{ts,tsx}",
  "packages/blueprints/apps/**/*.{ts,tsx}",
  "apps/mobile/src/**/*.{ts,tsx}",
  "apps/desktop/src/**/*.{ts,tsx}",
  "apps/web/src/**/*.{ts,tsx}",
  "apps/extension/src/**/*.{ts,tsx}",
  "packages/design/src/**/*.{ts,tsx}",
  "packages/server/src/routes/**/*.ts",
];

const COPY_SKIP_FILE =
  /(?:\.test\.|\.spec\.|\.stories\.|\.d\.ts$|__fixtures__|\/fixtures\/|-fixtures\.|^packages\/design\/src\/roles\.ts$)/u;

const COPY_BANNED_FILLER =
  /\b(?:please|successfully|simply|in order to|you can|we're sorry)\b/iu;

const COPY_CODEY =
  /(?:^[\s./#@-]|[<>{}]|=>|\$\{|::|\bhttps?:\/\/|\w\(\)|;\s|\|\||&&|\bSELECT\b|\bINSERT\b|\bUPDATE\b\s|\bFROM\b|\bWHERE\b|\bJOIN\b|_[a-z]|--|\bfunction\b|\bconst\b)/u;

const COPY_PROSE_CHARS = /^[\p{L}\p{N}\s'’“”"(),.:;!?%$&+/–—-]+$/u;

const COPY_MACHINE_KEY =
  /(?:^|[^A-Za-z])(?:id|ids|key|keys|className|class|href|src|url|uri|path|paths|route|routes|testId|testID|dataTestId|icon|slug|kind|type|variant|color|tone|size|font|event|entity|column|table|sql|query|selector|locale|timeZone|format|mime|ext|scope|command|capability|permission|method|op|field|token|tag|tags|status|state|role|storageKey|channel|topic|schema|version|env|flag|feature|app|appId|blueprint|module|package|namespace)\s*[:=]\s*$/u;

const COPY_MACHINE_CALL =
  /(?:console\.\w+|require|import|describe|test|it|expect|createHash|new Error|new TypeError|matchMedia|querySelector\w*|getElementById|createElement|addEventListener|removeEventListener|setAttribute|getAttribute|startsWith|endsWith|includes|split|join|replace|replaceAll|match|has|get|set|emit|on|off|log|warn|debug|trace)\s*\(\s*$/u;

function stripComments(source: string): string {
  let out = "";
  let mode: "code" | "line" | "block" | "string" = "code";
  let quote = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] as string;
    const next = source[index + 1];
    if (mode === "code") {
      if (char === "/" && (next === "/" || next === "*")) {
        mode = next === "/" ? "line" : "block";
        out += "  ";
        index += 1;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        mode = "string";
        quote = char;
      }
      out += char;
      continue;
    }
    if (mode === "line") {
      if (char === "\n") mode = "code";
      out += char === "\n" ? char : " ";
      continue;
    }
    if (mode === "block") {
      if (char === "*" && next === "/") {
        mode = "code";
        out += "  ";
        index += 1;
        continue;
      }
      out += char === "\n" ? char : " ";
      continue;
    }
    out += char;
    if (char === "\\") {
      out += source[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (char === quote) mode = "code";
    else if (char === "\n" && quote !== "`") mode = "code";
  }
  return out;
}

function copySentenceCount(text: string): number {
  const inner = text.match(/[.!?…](?=\s+["'(]?\p{Lu})/gu)?.length ?? 0;
  return inner + (/[.!?…]["')]?\s*$/u.test(text) ? 1 : 0);
}

function scanCopy(
  file: string,
  rawSource: string
): Array<{ file: string; literal: string; reasons: string[] }> {
  const source = stripComments(rawSource);
  const flagged: Array<{ file: string; literal: string; reasons: string[] }> =
    [];
  const pattern =
    /(?<quote>['"`])(?<body>(?:\\.|(?!\k<quote>)[^\\])*)\k<quote>/gsu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const raw = match.groups?.["body"] ?? "";
    if (match.groups?.["quote"] === "`" && raw.includes("${")) continue;
    const text = raw.replaceAll("\\n", " ").replaceAll("\\'", "'").trim();
    if (text.length < 16) continue;
    if (!/^\p{Lu}/u.test(text)) continue;
    if (text.split(/\s+/u).length < 3) continue;
    if (COPY_CODEY.test(text)) continue;
    if (!COPY_PROSE_CHARS.test(text)) continue;
    if (text.replace(/[^\p{L}]/gu, "").length / text.length < 0.7) continue;
    const before = source.slice(Math.max(0, match.index - 60), match.index);
    if (COPY_MACHINE_KEY.test(before) || COPY_MACHINE_CALL.test(before))
      continue;
    const reasons: string[] = [];
    if (text.length > 120) reasons.push("length");
    if (copySentenceCount(text) >= 2) reasons.push("sentences");
    if (COPY_BANNED_FILLER.test(text)) reasons.push("filler");
    if (reasons.length) flagged.push({ file, literal: text, reasons });
  }
  return flagged;
}

const REPLICA_REQUEST_KEYS = new Set([
  "entity",
  "limit",
  "orderBy",
  "purpose",
  "query",
  "shapeId",
  "where",
]);

function replicaObjectLiteral(
  source: string,
  open: number
): { body: string; keys: string[] } {
  const keys: string[] = [];
  let depth = 0;
  let quote = "";
  let index = open;
  for (; index < source.length; index += 1) {
    const char = source[index] as string;
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{" || char === "[" || char === "(") {
      depth += 1;
      continue;
    }
    if (char === "}" || char === "]" || char === ")") {
      depth -= 1;
      if (depth === 0) break;
      continue;
    }
    if (depth === 1 && /[A-Za-z_$]/u.test(char)) {
      const word = /^[A-Za-z0-9_$]+/u.exec(source.slice(index))![0];
      if (/^\s*:/u.test(source.slice(index + word.length))) keys.push(word);
      index += word.length - 1;
    }
  }
  return { body: source.slice(open, index + 1), keys };
}

function replicaEnclosingBrace(source: string, index: number): number {
  let depth = 0;
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const char = source[cursor];
    if (char === "}" || char === ")" || char === "]") depth += 1;
    else if (char === "{" || char === "(" || char === "[") {
      if (depth === 0) return char === "{" ? cursor : -1;
      depth -= 1;
    }
  }
  return -1;
}

function scanReplicaReads(
  file: string,
  rawSource: string,
  growthEntities: ReadonlySet<string>
): string[] {
  const source = stripComments(rawSource);
  const unbounded: string[] = [];
  for (const match of source.matchAll(
    /entity:\s*["'](?<entity>[^"']+)["']/gu
  )) {
    const entity = match.groups?.["entity"];
    if (!entity || !growthEntities.has(entity)) continue;
    const open = replicaEnclosingBrace(source, match.index);
    if (open < 0) continue;
    const { body, keys } = replicaObjectLiteral(source, open);
    if (!keys.every((key) => REPLICA_REQUEST_KEYS.has(key))) continue;
    const bounded =
      /\blimit\s*:/u.test(body) || /\bop\s*:\s*["'](?:eq|in)["']/u.test(body);
    if (!bounded) unbounded.push(`${file}#${entity}`);
  }
  return unbounded;
}

describe("issue #679 user-facing quality gates", () => {
  test("A1/A3/A4: every visible quality claim is classified, governed and demonstrated red", async () => {
    const claimsFile = await json("tests/claims.json");
    const claims = claimsFile["claims"] as Array<{
      id: string;
      family: string;
      severity: string;
      owner: string;
      knob: string;
      governance: string;
      demonstratedRed: {
        date: string;
        command: string;
        seed: string;
        failure: string;
      };
    }>;
    expect(
      [...new Set(claims.map((claim) => claim.family))].toSorted()
    ).toStrictEqual(
      [
        "correctness",
        "friction",
        "longevity",
        "reliability",
        "responsiveness",
        "transparency",
        "trust",
      ].toSorted()
    );
    expect(new Set(claims.map((claim) => claim.id)).size).toBe(claims.length);
    await Promise.all(
      claims.flatMap((claim) => [
        access(path.join(root, claim.owner.split("#", 1)[0]!)),
        access(path.join(root, claim.knob.split("#", 1)[0]!)),
      ])
    );
    for (const claim of claims) {
      expect(["tighten-only", "waiver-gated", "none"]).toContain(
        claim.governance
      );
      expect(["S1", "S2", "S3", "S4"]).toContain(claim.severity);
      expect(Number.isNaN(Date.parse(claim.demonstratedRed.date))).toBe(false);
      expect(claim.demonstratedRed.command).toMatch(/^(?:bun|node) /u);
      expect(claim.demonstratedRed.seed.length).toBeGreaterThan(8);
      expect(claim.demonstratedRed.failure.length).toBeGreaterThan(8);
    }
  });

  test("A2: the consolidated year-3 generator materializes deterministic vault and ledger axes", async () => {
    const first = year3VaultProfile();
    const second = year3VaultProfile();
    expect(second).toStrictEqual(first);
    expect(first.photos).toBe(90_000);
    expect(first.conversations * first.turnsPerConversation).toBeGreaterThan(0);
    expect(Object.keys(first.sealedSentinels).length).toBeGreaterThan(0);
    expect(first.parkedActions.length).toBeGreaterThan(0);
    expect(year3FixtureCacheKey(second, 4)).toBe(
      year3FixtureCacheKey(first, 4)
    );
    expect(year3FixtureCacheKey(first, 4)).not.toBe(
      year3FixtureCacheKey(first, 5)
    );
    const db = await createTestVault();
    seedYear3Vault(
      {
        vault: db.vault,
        sealCell: (entity, column, rowId, plaintext) =>
          sealValue(
            db.sealKey,
            sealAad(entity.replace(".", "_"), column, rowId),
            plaintext
          ),
      },
      { parties: 7, photos: 11, conversations: 3, turnsPerConversation: 4 }
    );
    expect(
      (
        db.vault.prepare("SELECT count(*) AS n FROM media_asset").get() as {
          n: number;
        }
      ).n
    ).toBe(11);
    expect(
      (
        db.audit.prepare("SELECT count(*) AS n FROM turns").get() as {
          n: number;
        }
      ).n
    ).toBe(12);
    const sealed = db.vault
      .prepare(
        "SELECT password, otp_seed, card_number, cvv, content FROM locker_item WHERE item_id='year3-sealed-locker'"
      )
      .get() as Record<string, string>;
    expect(Object.values(sealed).every(isSealedValue)).toBe(true);
    const cacheRoot = await tempDir("quality-year3-cache-");
    let generated = 0;
    const generate = async (target: string): Promise<void> => {
      generated += 1;
      await writeFile(path.join(target, "checkpointed.db"), "fixture");
    };
    const miss = await materializeYear3Fixture(cacheRoot, generate, first);
    const hit = await materializeYear3Fixture(cacheRoot, generate, first);
    expect({ miss: miss.cacheHit, hit: hit.cacheHit, generated }).toStrictEqual(
      { miss: false, hit: true, generated: 1 }
    );
  });

  test("T2/F1: classified writes park before mutation and ledger their decision", async () => {
    expect(VAULT_MCP_TOOL_REGISTRY.length).toBeGreaterThan(0);
    for (const tool of VAULT_MCP_TOOL_REGISTRY) {
      expect(tool.consent).toBeTruthy();
      expect(tool.sideEffect).toMatch(/^(?:none|write)$/u);
      expect(tool.ledger).toBe(true);
    }
    expect(AUTOMATION_TRIGGER_KINDS).toStrictEqual(
      Object.keys(AUTOMATION_TRIGGER_REGISTRY)
    );
    for (const registration of Object.values(AUTOMATION_TRIGGER_REGISTRY)) {
      expect(registration.consent).toBeTruthy();
      expect(registration.sideEffect).toBeTruthy();
      expect(registration.ledger).toBe(true);
    }
    const dir = await tempDir("quality-consent-");
    const plane = openVaultPlane({
      bootstrap: true,
      dir,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      ownerName: "Quality owner",
    });
    try {
      const added = await plane.invoke(plane.ownerCredential, {
        command: "locker.add_item",
        input: { type: "login", title: "Consent canary", password: "secret" },
        purpose: "dpv:ServiceProvision",
      });
      expect(added.status).toBe("executed");
      const itemId = (added as { output: { item_id: string } }).output.item_id;
      const parked = await plane.invokeAsAssistant({
        command: "locker.purge_item",
        input: { item_id: itemId },
        purpose: "dpv:ServiceProvision",
      });
      expect(parked.status).toBe("parked");
      expect(
        plane.db.vault
          .prepare("SELECT count(*) AS n FROM locker_item WHERE item_id = ?")
          .get(itemId)
      ).toMatchObject({ n: 1 });
      const invocationId = (parked as { invocationId: string }).invocationId;
      expect(
        plane.db.audit
          .prepare(
            "SELECT status FROM agent_command_invocation WHERE invocation_id = ?"
          )
          .get(invocationId)
      ).toMatchObject({ status: "proposed" });
      expect(plane.confirmParked(invocationId, true).status).toBe("executed");
      expect(
        plane.db.audit
          .prepare(
            "SELECT decision FROM access_receipt WHERE invocation_id = ?"
          )
          .get(invocationId)
      ).toMatchObject({ decision: "allow" });
      expect(
        plane.db.vault
          .prepare("SELECT count(*) AS n FROM locker_item WHERE item_id = ?")
          .get(itemId)
      ).toMatchObject({ n: 0 });

      const automationItem = await plane.invoke(plane.ownerCredential, {
        command: "locker.add_item",
        input: {
          type: "login",
          title: "Automation consent canary",
          password: "automation-secret",
        },
        purpose: "dpv:ServiceProvision",
      });
      const automationItemId = (
        automationItem as { output: { item_id: string } }
      ).output.item_id;
      plane.enrollAutomationAgent("quality");
      plane.approveAgentGrant("quality", {
        purpose: "dpv:ServiceProvision",
        scopes: [{ schema: "locker", verbs: "read+act" }],
      });
      const codeAppsDir = await tempDir("quality-consent-automation-");
      const automationDir = path.join(
        codeAppsDir,
        "quality",
        "automations",
        "consent"
      );
      await mkdir(automationDir, { recursive: true });
      await writeFile(
        path.join(automationDir, "automation.json"),
        JSON.stringify({
          name: "Consent canary",
          version: "0.1.0",
          enabled: true,
          prompt: "purge the selected item",
          triggers: [],
          requires: {},
          vault: {
            purpose: "dpv:ServiceProvision",
            scopes: [{ schema: "locker", verbs: "read+act" }],
          },
          history: { keep: { count: 100 } },
          generated: { by: "quality-gate", at: "2026-08-01" },
        })
      );
      await writeFile(
        path.join(automationDir, "handler.js"),
        `export default async ({ ctx }) => ({ output: await ctx.vault.invoke({ command: 'locker.purge_item', input: { item_id: '${automationItemId}' }, purpose: 'dpv:ServiceProvision' }) });\n`
      );
      const automated = await runFire(
        {
          automationRef: "quality/consent",
          runId: "quality-consent-fire",
          appsDir: plane.db.dir,
          ledgerDbFile: path.join(plane.db.dir, "vault.db"),
          codeAppsDir,
          harnessKind: HARNESS_KINDS[0],
          triggerKind: "scheduled",
          triggerOrigin: "cron",
          vaultFor: () => plane.agentBridgeFor("quality"),
        },
        {
          openDispatch: async () => ({
            delegateDispatcher: async () => "unused",
            close: async () => undefined,
          }),
        }
      );
      expect(automated.outcome.output).toMatchObject({ status: "parked" });
      expect(
        plane.db.vault
          .prepare("SELECT count(*) AS n FROM locker_item WHERE item_id = ?")
          .get(automationItemId)
      ).toMatchObject({ n: 1 });
      const automationAgent = plane.db.vault
        .prepare(
          "SELECT agent_id FROM access_agent WHERE enrollment_key = 'quality'"
        )
        .get() as { agent_id: string };
      const proposed = plane.db.audit
        .prepare(
          `SELECT invocation_id, status FROM agent_command_invocation
            WHERE caller_id = ?
            ORDER BY requested_at DESC LIMIT 1`
        )
        .get(automationAgent.agent_id) as {
        invocation_id: string;
        status: string;
      };
      expect(proposed.status).toBe("proposed");
      expect(plane.confirmParked(proposed.invocation_id, true).status).toBe(
        "executed"
      );
      expect(
        plane.db.vault
          .prepare("SELECT count(*) AS n FROM locker_item WHERE item_id = ?")
          .get(automationItemId)
      ).toMatchObject({ n: 0 });
    } finally {
      plane.stop();
    }
  });

  test("T2: every shipped app action declares consent and an inherited side-effect class", async () => {
    const actionKitFile = "packages/blueprints/apps/_shared/action-kit.ts";
    const actionKitImport = /_shared\/action-kit(?:\.tsx?)?["']/u;
    const actionKitSource = await readFile(
      path.join(root, actionKitFile),
      "utf8"
    );
    expect(
      actionKitSource,
      `${actionKitFile} no longer dispatches through ctx.vault — the action kit is the seam every handler now inherits, so an indirection that stopped calling the vault would silently un-govern all of them`
    ).toContain("ctx.vault.invoke(");
    const files: string[] = [];
    for await (const file of glob("packages/blueprints/**/app.json", {
      cwd: root,
    }))
      files.push(file);
    const manifests = await Promise.all(
      files.map(async (file) => ({ file, manifest: await json(file) }))
    );
    const actionEntries = manifests.flatMap(({ file, manifest }) => {
      const actions = (manifest["actions"] ?? []) as Array<{
        name?: unknown;
        confirmation?: unknown;
        writes?: unknown;
      }>;
      expect(
        actions.length === 0 || manifest["actionSideEffect"] === "vault-write",
        `${file} actions have no side-effect class`
      ).toBe(true);
      return actions.map((action) => ({ action, file }));
    });
    await Promise.all(
      actionEntries.map(async ({ action, file }) => {
        expect(
          Array.isArray(action.writes),
          `${file} action is unclassified`
        ).toBe(true);
        expect(
          action.confirmation === "none" || action.confirmation === "required",
          `${file} action has no consent class`
        ).toBe(true);
        expect(action.name, `${file} action has no name`).toBeTypeOf("string");
        const actionFile = file.replace(
          /app\.json$/u,
          `actions/${String(action.name)}.ts`
        );
        const source = await readFile(path.join(root, actionFile), "utf8");
        expect(
          source.includes("ctx.vault") ||
            (actionKitImport.test(source) &&
              source.includes("runVaultAction(")),
          `${actionFile} bypasses the consent-recording vault command seam: it neither calls ctx.vault itself nor dispatches through ${actionKitFile}'s runVaultAction`
        ).toBe(true);
      })
    );
  });

  test("F1: every harness turn, harness tool, and automation trigger persists through conversation/turn/item", async () => {
    const db = await createTestVault();
    const owner = db.vault
      .prepare("SELECT self_party_id FROM core_vault LIMIT 1")
      .get() as { self_party_id: string };
    const history = new ConversationHistoryStore(() => ({
      vaultId: "quality-ledger",
      ownerPartyId: owner.self_party_id,
      appsDir: path.join(db.dir, "apps"),
      journal: () => db.audit,
      ledgerDbFile: path.join(db.dir, "vault.db"),
      harnessSessionDir: path.join(db.dir, "harness-sessions"),
    }));
    const starts: Array<{
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }> = [];
    const results: Array<{
      toolCallId: string;
      toolName: string;
      ok: boolean;
      result: unknown;
      errorText?: string;
    }> = [];
    const mcp = await startVaultMcpServer(
      {
        appId: "_assistant",
        dispatcher: {} as never,
        turnId: "quality-mcp-turn",
        vaultSql: async () => ({
          columns: ["n"],
          rows: [{ n: 1 }],
          totalRows: 1,
          truncated: false,
          durationMs: 0,
        }),
        vaultInvoke: async () => ({ status: "executed", invocationId: "q" }),
        vaultContent: async () => ({ text: "quality", truncated: false }),
      },
      {
        onStart: (call) => starts.push(call),
        onResult: (call) => results.push(call),
      }
    );
    try {
      const argumentsByTool: Record<string, Record<string, unknown>> = {
        vault_sql: { sql: "SELECT 1 AS n" },
        vault_invoke: { command: "quality.write", input: {} },
        vault_content: { content_id: "quality-content" },
      };
      await forEachSequentially(
        [...VAULT_MCP_TOOL_REGISTRY.entries()],
        async ([index, tool]) => {
          const response = await fetch(mcp.server.url, {
            method: "POST",
            headers: Object.fromEntries(
              mcp.server.headers.map((header) => [header.name, header.value])
            ),
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: index + 1,
              method: "tools/call",
              params: {
                name: tool.descriptor.name,
                arguments: argumentsByTool[tool.descriptor.name],
              },
            }),
          });
          expect(response.status).toBe(200);
          expect((await response.json()) as object).toHaveProperty("result");
        }
      );
    } finally {
      await mcp.close();
    }
    expect(results).toHaveLength(VAULT_MCP_TOOL_REGISTRY.length);
    const session = history.createSession("_assistant", "quality MCP ledger");
    history.recordTurn("_assistant", {
      conversationId: session.id,
      userMessage: "exercise every MCP tool",
      nodes: starts.map((start, index) => ({
        kind: "tool" as const,
        toolName: start.toolName,
        args: start.args,
        ok: results[index]!.ok,
        result: results[index]!.result,
        startedAt: index * 2 + 1,
        endedAt: index * 2 + 2,
      })),
      finalText: "done",
      harnessObservation: {
        kind: HARNESS_KINDS[0]!,
        sessionId: "quality-mcp",
      },
      startedAt: 1,
      endedAt: 20,
      ok: true,
    });

    const codeAppsDir = await tempDir("quality-automation-code-");
    const automationDir = path.join(
      codeAppsDir,
      "quality",
      "automations",
      "gate"
    );
    await mkdir(automationDir, { recursive: true });
    await writeFile(
      path.join(automationDir, "automation.json"),
      JSON.stringify({
        name: "Quality ledger",
        version: "0.1.0",
        enabled: true,
        prompt: "exercise the ledger",
        triggers: [],
        requires: {},
        history: { keep: { count: 100 } },
        generated: { by: "quality-gate", at: "2026-08-01" },
      })
    );
    await writeFile(
      path.join(automationDir, "handler.js"),
      "export default async ({ ctx }) => ({ output: await ctx.delegate('quality ledger') });\n"
    );
    await forEachSequentially(
      [...HARNESS_KINDS.entries()],
      async ([index, harnessKind]) => {
        const triggerKind =
          AUTOMATION_TRIGGER_KINDS[index % AUTOMATION_TRIGGER_KINDS.length]!;
        const automationId = `gate-${index}`;
        const caseDir = path.join(
          codeAppsDir,
          "quality",
          "automations",
          automationId
        );
        await mkdir(caseDir, { recursive: true });
        await writeFile(
          path.join(caseDir, "automation.json"),
          await readFile(path.join(automationDir, "automation.json"), "utf8")
        );
        await writeFile(
          path.join(caseDir, "handler.js"),
          await readFile(path.join(automationDir, "handler.js"), "utf8")
        );
        const runId = `quality-trigger-${index}-${triggerKind}`;
        const fire = await runFire(
          {
            automationRef: `quality/${automationId}`,
            runId,
            appsDir: db.dir,
            ledgerDbFile: path.join(db.dir, "vault.db"),
            codeAppsDir,
            harnessKind,
            triggerKind: "scheduled",
            triggerOrigin: triggerKind,
            input: { triggerKind },
          },
          {
            openDispatch: async () => ({
              delegateDispatcher: async () => `handled ${triggerKind}`,
              close: async () => undefined,
            }),
          }
        );
        expect(fire.outcome.ok, triggerKind).toBe(true);
      }
    );
    const persisted = db.audit
      .prepare(
        `SELECT c.harness_kind, t.trigger_origin, i.name
           FROM conversations c
           JOIN turns t ON t.conversation_id = c.id
           JOIN items i ON i.turn_id = t.id
          WHERE c.id = ? OR t.id LIKE 'quality-trigger-%'`
      )
      .all(session.id) as Array<{
      harness_kind: string;
      trigger_origin: string;
      name: string;
    }>;
    const persistedNames = new Set(persisted.map((row) => row.name));
    for (const tool of VAULT_MCP_TOOL_REGISTRY)
      expect(
        persistedNames.has(tool.descriptor.name),
        `${tool.descriptor.name}: ${JSON.stringify(persisted)}`
      ).toBe(true);
    for (const triggerKind of AUTOMATION_TRIGGER_KINDS)
      expect(
        persisted.some((row) => row.trigger_origin === triggerKind),
        triggerKind
      ).toBe(true);
    for (const harness of HARNESS_KINDS)
      expect(
        persisted.some((row) => row.harness_kind === harness),
        harness
      ).toBe(true);
  });

  test("T3 sealed canary: every declared column stays out of storage, SQL, export, ledger, and provider context", async () => {
    const declared = Object.entries(SEALED_COLUMNS).flatMap(
      ([entity, columns]) => columns.map((column) => `${entity}.${column}`)
    );
    expect(declared.length).toBeGreaterThan(0);
    expect(new Set(declared).size).toBe(declared.length);
    expect(SEALED_ENFORCEMENT_POINTS).toHaveLength(6);
    expect(SEALED_LEAK_SURFACES).toContain("provider-egress");
    const emittedLogs: string[] = [];
    const t3Dir = await tempDir("quality-t3-product-surfaces-");
    const t3Plane = openVaultPlane({
      bootstrap: true,
      dir: t3Dir,
      ownerName: "T3 owner",
      logger: {
        info: (message) => emittedLogs.push(`info:${message}`),
        warn: (message) => emittedLogs.push(`warn:${message}`),
        error: (message) => emittedLogs.push(`error:${message}`),
      },
      enableWalShipper: false,
    });
    const db = t3Plane.db;
    seedYear3Vault(
      {
        vault: db.vault,
        sealCell: (entity, column, rowId, plaintext) =>
          sealValue(
            db.sealKey,
            sealAad(entity.replace(".", "_"), column, rowId),
            plaintext
          ),
      },
      { parties: 1, photos: 1, conversations: 1, turnsPerConversation: 1 }
    );
    const profile = year3VaultProfile();
    expect(
      Object.keys(profile.sealedSentinels).toSorted(compareStrings)
    ).toStrictEqual(declared.toSorted(compareStrings));
    const device = db.vault
      .prepare("SELECT device_id, public_key FROM access_device LIMIT 1")
      .get() as { device_id: string; public_key: string };
    const ownerParty = db.vault
      .prepare("SELECT self_party_id FROM core_vault LIMIT 1")
      .get() as { self_party_id: string };
    const gateway = createGateway(db);
    registerLockerCommands(gateway);
    const sqlArtifacts = [
      gateway.sql(
        {
          kind: "device",
          deviceId: device.device_id,
          deviceKey: device.public_key,
        },
        {
          sql: "SELECT password, otp_seed, card_number, cvv, content FROM locker_item",
        }
      ),
      gateway.sql(
        {
          kind: "device",
          deviceId: device.device_id,
          deviceKey: device.public_key,
        },
        {
          sql: "SELECT client_secret, access_token, refresh_token, api_key FROM sync_connection_credential",
        }
      ),
      ...[
        "SELECT value_sealed FROM locker_item_field WHERE item_id = 'year3-sealed-locker'",
        "SELECT private_key FROM locker_item_passkey WHERE item_id = 'year3-sealed-locker'",
      ].map((sql) =>
        gateway.sql(
          {
            kind: "device",
            deviceId: device.device_id,
            deviceKey: device.public_key,
          },
          { sql }
        )
      ),
    ];
    expect(sqlArtifacts.map((artifact) => artifact.rows.length)).not.toContain(
      0
    );
    expect(
      sqlArtifacts.flatMap((artifact) => artifact.rows.flatMap(Object.values))
    ).toSatisfy((values: unknown[]) =>
      values.every((value) => value === SEALED_PLACEHOLDER)
    );
    const snapshots = gateway.sql(
      {
        kind: "device",
        deviceId: device.device_id,
        deviceKey: device.public_key,
      },
      {
        sql: "SELECT snapshot_json FROM core_entity_revision WHERE entity_type = 'locker.item' AND entity_id = 'year3-sealed-locker'",
      }
    );
    expect(snapshots.rows.length).toBeGreaterThan(0);
    for (const row of snapshots.rows) {
      const snapshot = String(
        (row as { snapshot_json: unknown }).snapshot_json
      );
      for (const sentinel of Object.values(profile.sealedSentinels)) {
        expect(snapshot).not.toContain(sentinel);
      }
    }
    const portable = await exportPortableVault(db, {
      kind: "owner-device",
      callerId: device.device_id,
      provAgentKind: "owner",
      partyId: ownerParty.self_party_id,
      mayAct: true,
    });
    const credential = {
      kind: "device" as const,
      deviceId: device.device_id,
      deviceKey: device.public_key,
    };
    const invokedSentinel = profile.sealedSentinels["locker.item.password"];
    const invoked = gateway.invoke(credential, {
      command: "locker.add_item",
      input: {
        type: "login",
        title: "T3 journal canary",
        password: invokedSentinel,
      },
      purpose: "dpv:ServiceProvision",
    });
    expect(invoked.status).toBe("executed");
    const revealed = [
      gateway.reveal(credential, {
        entity: "locker.item",
        entityId: "year3-sealed-locker",
        purpose: "dpv:ServiceProvision",
      }),
      gateway.reveal(credential, {
        entity: "sync.connection_credential",
        entityId: "year3-sealed-connection",
        purpose: "dpv:ServiceProvision",
      }),
      gateway.reveal(credential, {
        entity: "locker.item_field",
        entityId: "year3-sealed-field",
        purpose: "dpv:ServiceProvision",
      }),
      gateway.reveal(credential, {
        entity: "locker.item_passkey",
        entityId: "year3-sealed-locker",
        purpose: "dpv:ServiceProvision",
      }),
    ];
    const revealedText = JSON.stringify(revealed);
    for (const sentinel of Object.values(profile.sealedSentinels))
      expect(revealedText, `reveal never returned ${sentinel}`).toContain(
        sentinel
      );
    const rawStorage = [
      db.vault.prepare("SELECT * FROM locker_item").all(),
      db.vault.prepare("SELECT * FROM sync_connection_credential").all(),
      db.vault.prepare("SELECT * FROM locker_item_field").all(),
      db.vault
        .prepare(
          "SELECT * FROM core_entity_revision WHERE entity_type = 'locker.item'"
        )
        .all(),
      db.vault.prepare("SELECT * FROM locker_item_passkey").all(),
    ];
    expect(JSON.stringify(rawStorage)).not.toContain("CENTRAID-SEALED-");
    const ftsTables = db.vault
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'fts_%' AND name NOT LIKE '%_data' AND name NOT LIKE '%_idx' AND name NOT LIKE '%_docsize' AND name NOT LIKE '%_config'"
      )
      .all() as Array<{ name: string }>;
    const ftsArtifact = ftsTables.map(({ name }) =>
      db.vault.prepare(`SELECT * FROM "${name}"`).all()
    );
    let errorArtifact = "";
    try {
      gateway.sql(credential, { sql: "SELECT missing FROM locker_item" });
    } catch (error) {
      errorArtifact = error instanceof Error ? error.message : String(error);
    }
    const replicaArtifact = withReplicaSnapshot(db.vault, (reader) => [
      reader.readRows("locker.item"),
      reader.readRows("sync.connection_credential"),
      reader.readRows("locker.item_field"),
      reader.readRows("core.entity_revision"),
      reader.readRows("locker.item_passkey"),
    ]);
    const backupArtifact = checkpointVault(db);
    const receipts = db.audit.prepare("SELECT * FROM access_receipt").all();
    const invocationArtifact = db.audit
      .prepare(
        "SELECT input_json FROM agent_command_invocation WHERE invocation_id = ?"
      )
      .get((invoked as { invocationId: string }).invocationId) as {
      input_json: string;
    };
    expect(invocationArtifact.input_json).toContain("sealed:sha256:");
    expect(invocationArtifact.input_json).not.toContain(invokedSentinel);
    const connectionId = ensureConnection(db, {
      kind: "quality-canary",
      label: "T3 draft boundary",
    });
    const staged = stageCandidates(
      db,
      {
        kind: "owner-device",
        callerId: device.device_id,
        provAgentKind: "owner",
        partyId: ownerParty.self_party_id,
        mayAct: true,
      },
      connectionId,
      Object.entries(SEALED_COLUMNS).map(([entityType, columns], index) => ({
        entityType,
        externalId: `t3-${index}`,
        payload: Object.fromEntries(
          columns.map((column) => [
            column,
            profile.sealedSentinels[`${entityType}.${column}`],
          ])
        ),
      })),
      new Map()
    );
    const stagedArtifact = db.vault
      .prepare(
        "SELECT payload_json FROM sync_import_row WHERE batch_id = ? ORDER BY seq"
      )
      .all(staged.batchId) as Array<{ payload_json: string }>;
    for (const row of stagedArtifact) {
      const payload = Object.values(JSON.parse(row.payload_json) as object);
      expect(payload.every(isSealedValue), row.payload_json).toBe(true);
    }
    const portableEntries = readZipEntries(portable.bytes);
    expect(portableEntries.length).toBeGreaterThan(1);
    const portableText = portableEntries
      .map((entry) => `${entry.name}\n${entry.data.toString("utf8")}`)
      .join("\n");
    const workspace = {
      vaultId: "quality-t3",
      ownerPartyId: ownerParty.self_party_id,
      appsDir: path.join(t3Dir, "apps"),
      journal: () => db.audit,
      ledgerDbFile: path.join(t3Dir, "vault.db"),
      harnessSessionDir: path.join(t3Dir, "harness-sessions"),
    };
    const conversationStore = new ConversationHistoryStore(() => workspace);
    let providerEgressArtifact = "";
    const assistantHandler = makeAssistantRouteHandler({
      vaults: {
        current: () => ({
          name: "T3",
          dir: t3Dir,
          boot: { vaultId: "quality-t3" },
          assistantContext: () => buildAssistantContext(db),
          resolveAsOwner: () => ({ cards: [], receiptId: "t3-receipt" }),
        }),
        currentWorkspace: () => workspace,
      } as never,
      conversationStore,
      runner: {
        async run(input) {
          providerEgressArtifact = JSON.stringify({
            message: input.message,
            extraSystemPrompt: input.extraSystemPrompt,
            attachments: input.attachments ?? [],
          });
          input.onEvent({ type: "final", text: "T3 canary response" });
        },
      },
      conversationLocks: new Map(),
    });
    const assistantServer = createServer((req, res) => {
      void assistantHandler(req, res).then((handled) => {
        if (!handled) {
          res.statusCode = 404;
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => {
      assistantServer.listen(0, "127.0.0.1", resolve);
    });
    const assistantBase = `http://127.0.0.1:${(assistantServer.address() as AddressInfo).port}`;
    const session = conversationStore.createSession(ASSISTANT_APP_ID);
    const sseResponse = await fetch(
      `${assistantBase}/centraid/_vault/assistant/_turn`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId: session.id,
          message: "Summarize without revealing secrets",
        }),
      }
    );
    expect(sseResponse.headers.get("content-type")).toMatch(
      /text\/event-stream/u
    );
    const sseArtifact = await sseResponse.text();
    await new Promise<void>((resolve, reject) => {
      assistantServer.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    const surfaceArtifacts: Record<
      (typeof SEALED_LEAK_SURFACES)[number],
      string
    > = {
      logs: emittedLogs.join("\n"),
      sse: sseArtifact,
      errors: errorArtifact,
      "backup-manifest": JSON.stringify(backupArtifact),
      "portable-export": portableText,
      "fts-index": JSON.stringify(ftsArtifact),
      "replica-snapshot": JSON.stringify(replicaArtifact),
      "provider-egress": providerEgressArtifact,
    };
    expect(
      Object.keys(surfaceArtifacts).toSorted(compareStrings)
    ).toStrictEqual([...SEALED_LEAK_SURFACES].toSorted(compareStrings));
    const enforcementArtifacts: Record<
      (typeof SEALED_ENFORCEMENT_POINTS)[number],
      string
    > = {
      "ciphertext-at-rest": JSON.stringify(rawStorage),
      "default-read-placeholder": JSON.stringify(sqlArtifacts),
      "receipted-reveal": JSON.stringify(receipts),
      "journal-hash": JSON.stringify(invocationArtifact),
      "fts-exclusion": JSON.stringify(ftsArtifact),
      "draft-stage-sealing": JSON.stringify(stagedArtifact),
    };
    expect(
      Object.keys(enforcementArtifacts).toSorted(compareStrings)
    ).toStrictEqual([...SEALED_ENFORCEMENT_POINTS].toSorted(compareStrings));
    for (const [surface, artifact] of Object.entries({
      ...surfaceArtifacts,
      ...enforcementArtifacts,
    }))
      for (const sentinel of Object.values(profile.sealedSentinels))
        expect(artifact, `${surface} leaked ${sentinel}`).not.toContain(
          sentinel
        );
    t3Plane.stop();
  });

  test("T4: boot-time route registration refuses every unclassified HTTP prefix", () => {
    expect(
      new Set(ROUTE_SECURITY_REGISTRY.map((route) => route.prefix)).size
    ).toBe(ROUTE_SECURITY_REGISTRY.length);
    for (const route of ROUTE_SECURITY_REGISTRY) {
      expect(route.auth).toMatch(/^(?:public|device|owner|admin)$/u);
      expect(route.vaultScope).toMatch(/^(?:none|active|path)$/u);
      expect(route.auth !== "public" || Boolean(route.reason)).toBe(true);
    }
    expect(() =>
      assertRouteSecurityCoverage([{ prefixes: ["/centraid/_new-surface"] }])
    ).toThrow("unclassified gateway route prefixes");
    expect(() =>
      assertRouteSecurityCoverage(
        ROUTE_SECURITY_REGISTRY.map((route) => ({ prefixes: [route.prefix] }))
      )
    ).not.toThrow();
  });

  test("R3: every expected health component flips unhealthy under induction", async () => {
    expect(
      new Set(EXPECTED_HEALTH_COMPONENTS.map((row) => row.component)).size
    ).toBe(EXPECTED_HEALTH_COMPONENTS.length);
    const dir = await tempDir("quality-health-drill-");
    const gateway = await buildGateway({
      paths: { vaultDir: path.join(dir, "vault") },
    });
    await gateway.start("http://127.0.0.1");
    try {
      expect(gateway.health.expectedRegistrationGaps()).toStrictEqual([]);
      await forEachSequentially(
        EXPECTED_HEALTH_COMPONENTS,
        async (expected) => {
          const restore = gateway.health.induceExpectedFailureForTest(
            expected.component
          );
          try {
            const component = (await gateway.health.snapshot()).components.find(
              (row) => row.component === expected.component
            );
            expect(component?.status, expected.component).toBe("error");
          } finally {
            restore();
          }
        }
      );
    } finally {
      await gateway.stop();
    }
  });

  test("P2: first-paint query budgets are per-screen identities, never an aggregate", async () => {
    const budgets = await json(
      "tests/experience-budgets/client-query-counts.json"
    );
    const screens = budgets["screens"] as Record<
      string,
      { sqlStatements: number; httpRequests: number }
    >;
    expect(Object.keys(screens).sort()).toStrictEqual([
      "assistant",
      "atlas",
      "notifications",
      "photos-grid",
    ]);
    for (const budget of Object.values(screens)) {
      expect(budget.sqlStatements).toBeGreaterThan(0);
      expect(budget.httpRequests).toBeGreaterThan(0);
    }
  });

  test("P3: runtime agent SQL has a non-optional hard row cap", () => {
    expect(VAULT_SQL_MAX_ROWS).toBeGreaterThan(0);
    expect(VAULT_SQL_MAX_ROWS).toBeLessThanOrEqual(1_000);
  });

  test("P3: repo-authored query handlers are bounded or explicitly waived", async () => {
    const waiverFile = await json("tests/quality/unbounded-query-waivers.json");
    const entries = waiverFile["entries"] as Array<{
      query: string;
      reason: string;
    }>;
    for (const entry of entries) {
      expect(entry.query, JSON.stringify(entry)).toBeTypeOf("string");
      expect(entry.reason.length, entry.query).toBeGreaterThan(8);
    }
    const waivers = new Set(entries.map((entry) => entry.query));
    expect(waivers.size).toBe(entries.length);
    const unbounded: string[] = [];
    const files: string[] = [];
    for (const pattern of [
      "packages/blueprints/apps/**/queries/*.js",
      "packages/blueprints/apps/**/queries/*.ts",
    ])
      for await (const file of glob(pattern, { cwd: root })) files.push(file);
    const sources = await Promise.all(
      files.map(async (file) => ({
        file,
        source: await readFile(path.join(root, file), "utf8"),
      }))
    );
    for (const { file, source } of sources) {
      if (!/\bSELECT\b/iu.test(source)) continue;
      const bounded =
        /\bLIMIT\b/iu.test(source) ||
        /\b(?:COUNT|SUM|AVG|MAX|MIN)\s*\(/iu.test(source);
      if (!bounded) unbounded.push(file);
    }
    const growthEntities = new Set([
      "business.order",
      "core.content_item",
      "core.event",
      "health.measurement",
      "knowledge.note",
      "media.asset",
      "schedule.task",
      "social.message",
      "tally.transaction",
    ]);
    for (const { file, source } of sources) {
      const needle = "ctx.vault.read(";
      let offset = 0;
      while ((offset = source.indexOf(needle, offset)) >= 0) {
        const start = offset + needle.length;
        let depth = 1;
        let cursor = start;
        for (; cursor < source.length && depth > 0; cursor += 1) {
          if (source[cursor] === "(") depth += 1;
          if (source[cursor] === ")") depth -= 1;
        }
        const body = source.slice(start, cursor - 1);
        const entity = /entity:\s*["'](?<entity>[^"']+)/u.exec(body)?.groups
          ?.entity;
        if (
          entity &&
          growthEntities.has(entity) &&
          !/\blimit\s*:/u.test(body) &&
          !/\bop\s*:\s*["'](?:eq|in)["']/u.test(body)
        )
          unbounded.push(`${file}#${entity}`);
        offset = Math.max(cursor, offset + needle.length);
      }
    }
    const mobileFiles = (
      await Promise.all(
        ["apps/mobile/src/**/*.ts", "apps/mobile/src/**/*.tsx"].map(globFiles)
      )
    )
      .flat()
      .map((file) => file.replaceAll("\\", "/"))
      .filter((file) => !COPY_SKIP_FILE.test(file))
      .toSorted(compareStrings);
    expect(mobileFiles.length).toBeGreaterThan(100);
    const mobileReads = await Promise.all(
      mobileFiles.map(async (file) =>
        scanReplicaReads(
          file,
          await readFile(path.join(root, file), "utf8"),
          growthEntities
        )
      )
    );
    unbounded.push(...mobileReads.flat());

    const found = new Set(unbounded);
    const violations = [
      ...[...found]
        .filter((query) => !waivers.has(query))
        .map((query) => `unwaived ${query}`),
      ...[...waivers]
        .filter((query) => !found.has(query))
        .map((query) => `stale ${query}`),
    ].toSorted(compareStrings);
    expect(violations).toStrictEqual([]);
  });

  test("U2: exact known-bad user-facing literals stay absent", async () => {
    const allowlistFile = await json("tests/quality/copy-allowlist.json");
    const allowlist = new Set(
      ((allowlistFile["entries"] ?? []) as Array<{ file: string }>).map(
        (entry) => entry.file
      )
    );
    const violations: string[] = [];
    const files: string[] = [];
    const userFacingFiles = await Promise.all(
      ["packages/client/src/**/*.tsx", "packages/blueprints/apps/**/*.tsx"].map(
        globFiles
      )
    );
    for (const matches of userFacingFiles) {
      for (const file of matches) {
        if (file.endsWith(".test.tsx") || allowlist.has(file)) continue;
        files.push(file);
      }
    }
    const sources = await Promise.all(
      files.map(async (file) => ({
        file,
        source: await readFile(path.join(root, file), "utf8"),
      }))
    );
    for (const { file, source } of sources) {
      if (/>(?:Spaces?|Approvals?|Inbox)</u.test(source)) violations.push(file);
      if (/aria-label=["'](?:Spaces?|Approvals?|Inbox)["']/u.test(source))
        violations.push(file);
    }
    expect(violations).toStrictEqual([]);
  });

  test("U4: user-facing copy stays short, single-thought and filler-free", async () => {
    const COPY_SEED_CEILING = 31;
    const allowlistFile = await json("tests/quality/copy-allowlist.json");
    const ratchet = allowlistFile["copyRatchet"] as {
      maxEntries: number;
      entries: Array<{ file: string; literal: string; reason: string }>;
    };
    expect(ratchet.maxEntries).toBeLessThanOrEqual(COPY_SEED_CEILING);
    expect(ratchet.entries.length).toBeLessThanOrEqual(ratchet.maxEntries);
    const keyed = (entry: { file: string; literal: string }): string =>
      `${entry.file} ${entry.literal}`;
    expect(new Set(ratchet.entries.map(keyed)).size).toBe(
      ratchet.entries.length
    );
    for (const entry of ratchet.entries)
      expect(entry.reason.length).toBeGreaterThan(8);

    const files = (await Promise.all(COPY_SCOPE.map(globFiles))).flat();
    const walked = files
      .map((file) => file.replaceAll("\\", "/"))
      .filter((file) => !COPY_SKIP_FILE.test(file))
      .toSorted(compareStrings);
    expect(walked.length).toBeGreaterThan(1000);
    const flagged = (
      await Promise.all(
        walked.map(async (file) =>
          scanCopy(file, await readFile(path.join(root, file), "utf8"))
        )
      )
    ).flat();
    const allowed = new Set(ratchet.entries.map(keyed));
    const present = new Set(flagged.map(keyed));
    const violations = [
      ...flagged
        .filter((item) => !allowed.has(keyed(item)))
        .map(
          (item) =>
            `unallowed ${item.reasons.join("+")} ${item.file}: ${item.literal.slice(0, 60)}`
        ),
      ...ratchet.entries
        .filter((entry) => !present.has(keyed(entry)))
        .map((entry) => `stale ${entry.file}: ${entry.literal.slice(0, 60)}`),
    ].toSorted(compareStrings);
    expect(violations).toStrictEqual([]);
  });

  test("F3: every confirmation-gated capability renders as an Approvals row", async () => {
    const approvalsModule = (await import(
      path.join(root, "packages/client/src/react/shell/routes/approvalsData.ts")
    )) as {
      buildParkedRow: (input: {
        invocationId: string;
        command: string;
        caller: string;
        callerId: string;
        callerKind: "agent";
        parkedAt: string;
        input: Record<string, unknown>;
      }) => { command: string };
    };
    const db = await createTestVault();
    const gateway = createGateway(db);
    registerLockerCommands(gateway);
    const capabilities = db.vault
      .prepare(
        `SELECT c.name
           FROM agent_capability cap
           JOIN agent_command c ON c.command_id = cap.command_id
          WHERE cap.requires_confirmation = 1
          ORDER BY c.name`
      )
      .all() as Array<{ name: string }>;
    expect(capabilities.length).toBeGreaterThan(0);
    const rendered = capabilities.map(({ name }, index) =>
      approvalsModule.buildParkedRow({
        invocationId: `quality-${index}`,
        command: name,
        caller: "Quality fixture",
        callerId: "quality-fixture",
        callerKind: "agent",
        parkedAt: "2026-08-01T00:00:00.000Z",
        input: { fixture: true },
      })
    );
    expect(rendered.map((row) => row.command)).toStrictEqual(
      capabilities.map((row) => row.name)
    );
  });

  test("L2: schema fingerprint and portable export owner are jointly ratcheted", async () => {
    const config = await json("tests/schema-export-fingerprint.json");
    expect(config["schemaFingerprint"]).toMatch(/^[a-f0-9]{64}$/u);
    expect(config["exportOwner"]).toBe(
      "packages/vault/src/gateway/portable-export.ts"
    );
  });
});
