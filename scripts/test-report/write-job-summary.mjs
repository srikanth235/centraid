/**
 * Append test-health markdown to $GITHUB_STEP_SUMMARY (and print to stdout).
 * Usage: node scripts/test-report/write-job-summary.mjs [--summary path] [--report-url url]
 */
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSummaryMarkdown } from './summary-markdown.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const flags = parseFlags(process.argv.slice(2));
const summaryPath = path.resolve(
  flags.summary ?? path.join(root, 'dist/test-report/summary.json'),
);
const reportUrl = flags['report-url'] ?? process.env.TEST_REPORT_PUBLIC_URL ?? '';
const runUrl =
  process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : '';

let summary = {};
try {
  summary = JSON.parse(await readFile(summaryPath, 'utf8'));
} catch {
  summary = {
    passed: 0,
    failed: 0,
    unhandledErrors: 0,
    cellsFailed: 0,
    cellsMissing: 0,
    coverageBelowFloor: [],
    validationErrorCount: 0,
    generatedAt: new Date().toISOString(),
    note: `summary missing at ${summaryPath}`,
  };
}

const md = renderSummaryMarkdown(summary, {
  reportUrl: reportUrl || undefined,
  runUrl: runUrl || undefined,
  title: flags.title ?? 'Test health',
});

if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, md, 'utf8');
}
process.stdout.write(md);

function parseFlags(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (!current.startsWith('--')) continue;
    result[current.slice(2)] = args[index + 1];
    index += 1;
  }
  return result;
}
