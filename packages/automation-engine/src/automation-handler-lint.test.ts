import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lintAutomationHandlerSource, formatHandlerLintError } from './automation-handler-lint.js';

const CLEAN_HANDLER = `
/** @type {import('@centraid/openclaw-plugin').AutomationHandler} */
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

describe('lintAutomationHandlerSource', () => {
  it('passes a replay-safe handler that routes everything through ctx.*', () => {
    assert.deepEqual(lintAutomationHandlerSource(CLEAN_HANDLER), []);
  });

  it('flags Date.now()', () => {
    const findings = lintAutomationHandlerSource('const t = Date.now();');
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.rule, 'no-date-now');
    assert.equal(findings[0]!.line, 1);
  });

  it('flags argless new Date() but not new Date(value)', () => {
    const bad = lintAutomationHandlerSource('const a = new Date(); const b = new Date(  );');
    assert.equal(bad.length, 2);
    assert.ok(bad.every((f) => f.rule === 'no-new-date'));
    assert.deepEqual(lintAutomationHandlerSource('const a = new Date(ctx.input.ms);'), []);
    assert.deepEqual(lintAutomationHandlerSource("const a = new Date('2026-01-01');"), []);
  });

  it('flags Math.random, randomUUID, crypto randomness, performance.now', () => {
    const rules = lintAutomationHandlerSource(
      `const r = Math.random();
       const id = randomUUID();
       const id2 = crypto.randomUUID();
       const bytes = randomBytes(16);
       const t = performance.now();`,
    ).map((f) => f.rule);
    assert.ok(rules.includes('no-math-random'));
    // crypto.randomUUID() and bare randomUUID() both match the same rule.
    assert.equal(rules.filter((r) => r === 'no-random-uuid').length, 2);
    assert.ok(rules.includes('no-random-bytes'));
    assert.ok(rules.includes('no-performance-now'));
  });

  it('flags raw fetch and node I/O imports', () => {
    const fetchFindings = lintAutomationHandlerSource("const r = await fetch('https://x');");
    assert.equal(fetchFindings[0]!.rule, 'no-raw-fetch');

    for (const imp of [
      "import { readFile } from 'fs/promises';",
      "import fs from 'node:fs';",
      "const cp = require('child_process');",
      "import { connect } from 'node:net';",
    ]) {
      const f = lintAutomationHandlerSource(imp);
      assert.equal(f[0]?.rule, 'no-node-io-import', `expected I/O flag for: ${imp}`);
    }
  });

  it('flags ambient process reads', () => {
    const findings = lintAutomationHandlerSource('const k = process.env.TOKEN;');
    assert.equal(findings[0]!.rule, 'no-process-ambient');
  });

  it('does not flag patterns that appear only in comments or strings', () => {
    const src = `
      // Do not call Date.now() here.
      /* Math.random() and fetch() are banned. */
      const note = 'avoid Date.now() and process.env';
      const tpl = \`text with Math.random() inside\`;
      return { summary: 'ok' };
    `;
    assert.deepEqual(lintAutomationHandlerSource(src), []);
  });

  it('DOES flag unsafe calls inside template-literal interpolation', () => {
    // eslint-disable-next-line no-template-curly-in-string -- this string IS handler source under test
    const findings = lintAutomationHandlerSource('const id = `req-${Math.random()}`;');
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.rule, 'no-math-random');
  });

  it('handles nested braces inside interpolation without desyncing', () => {
    // eslint-disable-next-line no-template-curly-in-string -- this string IS handler source under test
    const src = 'const s = `${ { a: 1 }.a + Date.now() }`; const ok = ctx.tool("x", {});';
    const findings = lintAutomationHandlerSource(src);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.rule, 'no-date-now');
  });

  it('reports accurate line/column and sorts by position', () => {
    const src = ['line one', 'const a = Math.random();', 'const b = Date.now();'].join('\n');
    const findings = lintAutomationHandlerSource(src);
    assert.equal(findings.length, 2);
    assert.equal(findings[0]!.line, 2);
    assert.equal(findings[0]!.rule, 'no-math-random');
    assert.equal(findings[1]!.line, 3);
    assert.equal(findings[1]!.rule, 'no-date-now');
  });
});

describe('formatHandlerLintError', () => {
  it('returns undefined when there are no findings', () => {
    assert.equal(formatHandlerLintError([]), undefined);
  });

  it('formats findings into a single authoring error mentioning the file and rules', () => {
    const findings = lintAutomationHandlerSource('const t = Date.now();');
    const msg = formatHandlerLintError(findings, 'automations/main/handler.js');
    assert.ok(msg);
    assert.match(msg!, /automations\/main\/handler\.js/);
    assert.match(msg!, /no-date-now/);
    assert.match(msg!, /1 replay-unsafe pattern/);
  });
});
