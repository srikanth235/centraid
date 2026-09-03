import { describe, expect, it } from "vitest";

import { lintHandlerSource, formatHandlerLintError } from "./lint.js";

const CLEAN_HANDLER = `
/** @type {import('@centraid/server/automation').AutomationHandler} */
export default async ({ ctx, log }) => {
  const since = await ctx.runs.last({ status: 'ok' });
  const prs = await ctx.vault.search({ entity: 'core.thread', text: 'foo/bar' });
  const fresh = prs.filter((p) => p.createdAt > (since?.startedAt ?? 0));
  const digest = await ctx.delegate({
    prompt: 'Summarize: ' + JSON.stringify(fresh),
    json: { type: 'object', properties: { summary: { type: 'string' } } },
  });
  await ctx.state.set('cursor', fresh.length);
  return { summary: digest.summary };
};
`;

describe(lintHandlerSource, () => {
  it("passes a clean handler that routes everything through ctx.*", () => {
    expect(lintHandlerSource(CLEAN_HANDLER)).toStrictEqual([]);
  });

  it("flags Date.now()", () => {
    const findings = lintHandlerSource("const t = Date.now();");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe("no-date-now");
    expect(findings[0]!.line).toBe(1);
  });

  it("flags argless new Date() but not new Date(value)", () => {
    const bad = lintHandlerSource(
      "const a = new Date(); const b = new Date(  );"
    );
    expect(bad).toHaveLength(2);
    expect(bad.every((f) => f.rule === "no-new-date")).toBeTruthy();
    expect(
      lintHandlerSource("const a = new Date(ctx.input.ms);")
    ).toStrictEqual([]);
    expect(
      lintHandlerSource("const a = new Date('2026-01-01');")
    ).toStrictEqual([]);
    expect(lintHandlerSource("const now = ctx.now;")).toStrictEqual([]);
  });

  it("flags Math.random, randomUUID, crypto randomness, performance.now", () => {
    const rules = lintHandlerSource(
      `const r = Math.random();
       const id = randomUUID();
       const id2 = crypto.randomUUID();
       const bytes = randomBytes(16);
       const t = performance.now();`
    ).map((f) => f.rule);
    expect(rules.includes("no-math-random")).toBeTruthy();
    expect(rules.filter((r) => r === "no-random-uuid")).toHaveLength(2);
    expect(rules.includes("no-random-bytes")).toBeTruthy();
    expect(rules.includes("no-performance-now")).toBeTruthy();
  });

  it("flags raw fetch and node I/O imports", () => {
    const fetchFindings = lintHandlerSource(
      "const r = await fetch('https://x');"
    );
    expect(fetchFindings[0]!.rule).toBe("no-raw-fetch");
    expect(fetchFindings[0]!.message).toContain("outbox.stage");
    expect(
      lintHandlerSource("const r = await ctx.fetch({ url });")
    ).toStrictEqual([]);
    expect(lintHandlerSource('globalThis.fetch("https://x");')[0]!.rule).toBe(
      "no-raw-fetch"
    );

    for (const imp of [
      "import { readFile } from 'fs/promises';",
      "import fs from 'node:fs';",
      "const cp = require('child_process');",
      "import { connect } from 'node:net';",
      "import { request } from 'node:https';",
      "import http from 'http';",
      "const tls = require('tls');",
    ]) {
      const f = lintHandlerSource(imp);
      expect(f[0]?.rule).toBe("no-node-io-import");
    }
  });

  it("flags ambient process reads", () => {
    const findings = lintHandlerSource("const k = process.env.TOKEN;");
    expect(findings[0]!.rule).toBe("no-process-ambient");
    expect(lintHandlerSource("const a = process.argv;")[0]!.rule).toBe(
      "no-process-ambient"
    );
    expect(lintHandlerSource("process.hrtime.bigint();")[0]!.rule).toBe(
      "no-process-ambient"
    );
  });

  it("allows only local asset I/O for release-managed model bundles", () => {
    const source = `
      import { readFile } from "node:fs/promises";
      const root = process.env.CENTRAID_AUTOMATION_RUNTIME_DIR;
      const random = Math.random();
      const response = await fetch("https://example.test");
    `;
    expect(
      lintHandlerSource(source, { allowLocalModelAssets: true }).map(
        (finding) => finding.rule
      )
    ).toStrictEqual(["no-math-random", "no-raw-fetch"]);
  });

  it("does not flag patterns that appear only in comments or strings", () => {
    const src = `
      // Do not call Date.now() here.
      /* Math.random() and fetch() are banned. */
      const note = 'avoid Date.now() and process.env';
      const tpl = \`text with Math.random() inside\`;
      return { summary: 'ok' };
    `;
    expect(lintHandlerSource(src)).toStrictEqual([]);
  });

  it("DOES flag unsafe calls inside template-literal interpolation", () => {
    const interpolation = String.fromCharCode(36, 123);
    const findings = lintHandlerSource(
      `const id = \`req-${interpolation}Math.random()}\`;`
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe("no-math-random");
  });

  it("handles nested braces inside interpolation without desyncing", () => {
    const interpolation = String.fromCharCode(36, 123);
    const src = `const s = \`${interpolation} { a: 1 }.a + Date.now() }\`; const ok = ctx.state.get("x");`;
    const findings = lintHandlerSource(src);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe("no-date-now");
  });

  it("flags the removed ctx.tool rail (dot and bracket forms)", () => {
    expect(lintHandlerSource('await ctx.tool("x.list", {});')[0]!.rule).toBe(
      "no-ctx-tool"
    );
    expect(lintHandlerSource('await ctx.tool ("x", {});')[0]!.rule).toBe(
      "no-ctx-tool"
    );
    expect(lintHandlerSource("await ctx['tool']('x', {});")[0]!.rule).toBe(
      "no-ctx-tool"
    );
    expect(lintHandlerSource('await ctx["tool"]("x", {});')[0]!.rule).toBe(
      "no-ctx-tool"
    );
    const msg = lintHandlerSource('ctx.tool("x", {});')[0]!.message;
    expect(msg).toContain("ctx.tool was removed");
    expect(msg).toContain("ctx.delegate");
  });

  it("reports accurate line/column and sorts by position", () => {
    const src = [
      "line one",
      "const a = Math.random();",
      "const b = Date.now();",
    ].join("\n");
    const findings = lintHandlerSource(src);
    expect(findings).toHaveLength(2);
    expect(findings[0]!.line).toBe(2);
    expect(findings[0]!.rule).toBe("no-math-random");
    expect(findings[1]!.line).toBe(3);
    expect(findings[1]!.rule).toBe("no-date-now");
  });
});

describe(formatHandlerLintError, () => {
  it("returns undefined when there are no findings", () => {
    expect(formatHandlerLintError([])).toBeUndefined();
  });

  it("formats findings into a single authoring error mentioning the file and rules", () => {
    const findings = lintHandlerSource("const t = Date.now();");
    const msg = formatHandlerLintError(findings, "automations/main/handler.js");
    expect(msg).toBeTruthy();
    expect(msg!).toMatch(/automations\/main\/handler\.js/u);
    expect(msg!).toMatch(/no-date-now/u);
    expect(msg!).toMatch(/1 unsafe pattern/u);
  });
});
