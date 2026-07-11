import { describe, expect, it } from 'vitest';
import { lintHandlerSource, formatHandlerLintError } from './lint.js';

const CLEAN_HANDLER = `
/** @type {import('@centraid/automation').AutomationHandler} */
export default async ({ ctx, log }) => {
  const since = await ctx.runs.last({ status: 'ok' });
  const prs = await ctx.tool('github.list_pull_requests', { repo: 'foo/bar' });
  const fresh = prs.filter((p) => p.createdAt > (since?.startedAt ?? 0));
  const digest = await ctx.agent({
    prompt: 'Summarize: ' + JSON.stringify(fresh),
    json: { type: 'object', properties: { summary: { type: 'string' } } },
  });
  await ctx.state.set('cursor', fresh.length);
  return { summary: digest.summary };
};
`;

describe('lintHandlerSource', () => {
  it('passes a clean handler that routes everything through ctx.*', () => {
    expect(lintHandlerSource(CLEAN_HANDLER)).toEqual([]);
  });

  it('flags Date.now()', () => {
    const findings = lintHandlerSource('const t = Date.now();');
    expect(findings.length).toBe(1);
    expect(findings[0]!.rule).toBe('no-date-now');
    expect(findings[0]!.line).toBe(1);
  });

  it('flags argless new Date() but not new Date(value)', () => {
    const bad = lintHandlerSource('const a = new Date(); const b = new Date(  );');
    expect(bad.length).toBe(2);
    expect(bad.every((f) => f.rule === 'no-new-date')).toBeTruthy();
    expect(lintHandlerSource('const a = new Date(ctx.input.ms);')).toEqual([]);
    expect(lintHandlerSource("const a = new Date('2026-01-01');")).toEqual([]);
  });

  it('flags Math.random, randomUUID, crypto randomness, performance.now', () => {
    const rules = lintHandlerSource(
      `const r = Math.random();
       const id = randomUUID();
       const id2 = crypto.randomUUID();
       const bytes = randomBytes(16);
       const t = performance.now();`,
    ).map((f) => f.rule);
    expect(rules.includes('no-math-random')).toBeTruthy();
    // crypto.randomUUID() and bare randomUUID() both match the same rule.
    expect(rules.filter((r) => r === 'no-random-uuid').length).toBe(2);
    expect(rules.includes('no-random-bytes')).toBeTruthy();
    expect(rules.includes('no-performance-now')).toBeTruthy();
  });

  it('flags raw fetch and node I/O imports', () => {
    const fetchFindings = lintHandlerSource("const r = await fetch('https://x');");
    expect(fetchFindings[0]!.rule).toBe('no-raw-fetch');
    // The steer names the actual external-write path (issue #308 B6).
    expect(fetchFindings[0]!.message).toContain('outbox.stage');
    // ctx.fetch is the audited connector rail, not ambient I/O — exempt…
    expect(lintHandlerSource('const r = await ctx.fetch({ url });')).toEqual([]);
    // …but other member spellings stay flagged.
    expect(lintHandlerSource('globalThis.fetch("https://x");')[0]!.rule).toBe('no-raw-fetch');

    for (const imp of [
      "import { readFile } from 'fs/promises';",
      "import fs from 'node:fs';",
      "const cp = require('child_process');",
      "import { connect } from 'node:net';",
    ]) {
      const f = lintHandlerSource(imp);
      expect(f[0]?.rule).toBe('no-node-io-import');
    }
  });

  it('flags ambient process reads', () => {
    const findings = lintHandlerSource('const k = process.env.TOKEN;');
    expect(findings[0]!.rule).toBe('no-process-ambient');
  });

  it('does not flag patterns that appear only in comments or strings', () => {
    const src = `
      // Do not call Date.now() here.
      /* Math.random() and fetch() are banned. */
      const note = 'avoid Date.now() and process.env';
      const tpl = \`text with Math.random() inside\`;
      return { summary: 'ok' };
    `;
    expect(lintHandlerSource(src)).toEqual([]);
  });

  it('DOES flag unsafe calls inside template-literal interpolation', () => {
    // eslint-disable-next-line no-template-curly-in-string -- this string IS handler source under test (#247)
    const findings = lintHandlerSource('const id = `req-${Math.random()}`;');
    expect(findings.length).toBe(1);
    expect(findings[0]!.rule).toBe('no-math-random');
  });

  it('handles nested braces inside interpolation without desyncing', () => {
    // eslint-disable-next-line no-template-curly-in-string -- this string IS handler source under test (#247)
    const src = 'const s = `${ { a: 1 }.a + Date.now() }`; const ok = ctx.tool("x", {});';
    const findings = lintHandlerSource(src);
    expect(findings.length).toBe(1);
    expect(findings[0]!.rule).toBe('no-date-now');
  });

  it('reports accurate line/column and sorts by position', () => {
    const src = ['line one', 'const a = Math.random();', 'const b = Date.now();'].join('\n');
    const findings = lintHandlerSource(src);
    expect(findings.length).toBe(2);
    expect(findings[0]!.line).toBe(2);
    expect(findings[0]!.rule).toBe('no-math-random');
    expect(findings[1]!.line).toBe(3);
    expect(findings[1]!.rule).toBe('no-date-now');
  });
});

describe('formatHandlerLintError', () => {
  it('returns undefined when there are no findings', () => {
    expect(formatHandlerLintError([])).toBe(undefined);
  });

  it('formats findings into a single authoring error mentioning the file and rules', () => {
    const findings = lintHandlerSource('const t = Date.now();');
    const msg = formatHandlerLintError(findings, 'automations/main/handler.js');
    expect(msg).toBeTruthy();
    expect(msg!).toMatch(/automations\/main\/handler\.js/);
    expect(msg!).toMatch(/no-date-now/);
    expect(msg!).toMatch(/1 unsafe pattern/);
  });
});
