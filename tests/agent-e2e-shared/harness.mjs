import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Shared run identity used by the desktop, mobile and pairing manual-QA adapters. */
export function defaultRunId() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * One verdict contract for every agent-driven exploratory surface. Platform
 * adapters own setup/teardown, but run metadata, notes, failures and result
 * summaries are deliberately identical and machine-greppable.
 */
export async function writeFlowVerdict({
  repoRoot,
  slug,
  runDir,
  elapsedMs,
  error,
  notes,
  result,
  metadata = {},
  debug,
  owner,
}) {
  const pass = !error && result?.pass !== false;
  const lines = [`# ${slug}`, '', `**${pass ? 'PASS' : 'FAIL'}** — ${elapsedMs}ms`, ''];
  for (const [label, value] of Object.entries({ 'run dir': runDir, ...metadata })) {
    lines.push(`- ${label}: \`${value}\``);
  }
  lines.push('');
  if (error) {
    lines.push('## Error', '```', error.stack ?? String(error), '```', '');
    if (debug) lines.push('## Debug', '', debug, '');
  }
  if (notes.length) {
    lines.push('## Notes');
    for (const note of notes) lines.push(`- ${note}`);
    lines.push('');
  }
  if (result?.notes) lines.push('## Result', String(result.notes), '');
  const verdict = path.join(runDir, 'verdict.md');
  await fs.writeFile(verdict, lines.join('\n'));
  if (owner) {
    const evidenceDir = path.join(repoRoot, 'artifacts', 'e2e');
    await fs.mkdir(evidenceDir, { recursive: true });
    await fs.writeFile(
      path.join(evidenceDir, `${slug}.json`),
      `${JSON.stringify({ lane: 'e2e', owner, name: slug, status: pass ? 'passed' : 'failed', capturedAt: new Date().toISOString(), measurements: [{ name: 'wall clock', value: elapsedMs, unit: 'ms' }] }, null, 2)}\n`,
    );
  }
  console.log(`[runFlow] ${slug} ${pass ? 'PASS' : 'FAIL'} in ${elapsedMs}ms`);
  console.log(`  verdict : ${path.relative(repoRoot, verdict)}`);
  return pass;
}
