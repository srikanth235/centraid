/**
 * Structural gate for the nightly product lane (#464): pairing journeys live
 * inside `.github/workflows/e2e.yml` and no longer depend on a standalone
 * pairing-relay workflow or a cross-run `gh run download`.
 *
 * This is the real shipped wiring (the YAML GHA executes), not a reimplementation
 * of the flows themselves.
 */
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const e2ePath = path.join(root, '.github/workflows/e2e.yml');
const removedPath = path.join(root, '.github/workflows/pairing-relay-e2e.yml');

const requiredFlowScripts = [
  'tests/agent-e2e-pairing/flows/device-pairing-lifecycle.mjs',
  'tests/agent-e2e-pairing/flows/pairing-ticket-hygiene.mjs',
  'tests/agent-e2e-pairing/flows/cross-network-relay.mjs',
];

const requiredJobs = [
  'pairing-lifecycle:',
  'pairing-ticket-hygiene:',
  'pairing-cross-network-relay:',
  // #532 — mutation scores must reach the report job via nightly-evidence-*.
  'mutation-testing:',
];

const requiredArtifactNames = [
  'nightly-evidence-pairing-lifecycle',
  'nightly-evidence-pairing-ticket-hygiene',
  'nightly-evidence-pairing-cross-network-relay',
  'nightly-evidence-mutation',
];

const errors = [];

const e2e = await readFile(e2ePath, 'utf8');
// Strip YAML comments so prose about retired cross-workflow fetch does not
// trip the shell-command ban.
const e2eCode = e2e
  .split('\n')
  .map((line) => {
    const hash = line.indexOf('#');
    return hash === -1 ? line : line.slice(0, hash);
  })
  .join('\n');

for (const job of requiredJobs) {
  if (!e2eCode.includes(job)) errors.push(`e2e.yml missing job key ${job}`);
}

for (const script of requiredFlowScripts) {
  if (!e2eCode.includes(script)) errors.push(`e2e.yml does not invoke ${script}`);
}

for (const name of requiredArtifactNames) {
  if (!e2eCode.includes(name)) errors.push(`e2e.yml missing artifact name ${name}`);
}

if (!e2eCode.includes('pattern: nightly-evidence-*')) {
  errors.push('e2e.yml report job must download nightly-evidence-* artifacts');
}

const reportIdx = e2eCode.indexOf('test-health-report:');
if (reportIdx === -1) {
  errors.push('e2e.yml missing test-health-report job');
} else {
  const reportChunk = e2eCode.slice(reportIdx, reportIdx + 1_200);
  for (const need of [
    'mobile-e2e-android',
    'pairing-lifecycle',
    'pairing-ticket-hygiene',
    'pairing-cross-network-relay',
    'mutation-testing',
  ]) {
    if (!reportChunk.includes(need)) {
      errors.push(`test-health-report needs must include ${need}`);
    }
  }
}

// #532 — mutation upload must be `path: artifacts/` (not `artifacts/mutation/`).
// download-artifact merge-multiple into `artifacts` flattens the uploaded root:
// uploading the mutation subdir alone lands scores.json at artifacts/scores.json
// while generate.mjs reads artifacts/mutation/scores.json.
const mutationJobIdx = e2eCode.indexOf('mutation-testing:');
if (mutationJobIdx === -1) {
  errors.push('e2e.yml missing mutation-testing job');
} else {
  const mutationChunk = e2eCode.slice(mutationJobIdx, mutationJobIdx + 1_800);
  if (!mutationChunk.includes('nightly-evidence-mutation')) {
    errors.push('mutation-testing job must upload artifact nightly-evidence-mutation');
  }
  // Prefer path: artifacts/ over path: artifacts/mutation/ so the mutation/
  // prefix survives download into the report job.
  if (/path:\s*artifacts\/mutation\/?/.test(mutationChunk)) {
    errors.push(
      'mutation-testing must upload path: artifacts/ (not artifacts/mutation/) so scores stay at artifacts/mutation/scores.json after merge-multiple download',
    );
  } else if (
    !/path:\s*artifacts\/?\s*$/m.test(mutationChunk) &&
    !/path:\s*artifacts\/\s*$/m.test(mutationChunk)
  ) {
    // Accept `path: artifacts/` or `path: artifacts`
    if (
      !/name:\s*nightly-evidence-mutation[\s\S]{0,200}?path:\s*artifacts\/?/.test(mutationChunk)
    ) {
      errors.push(
        'mutation-testing must upload path: artifacts/ next to nightly-evidence-mutation (preserves mutation/ prefix for generate.mjs)',
      );
    }
  }
}

// Executable shell cross-workflow fetch — ban the retired pairing satellite.
const shellBans = [
  /gh\s+run\s+list[^\n]*pairing-relay-e2e/,
  /gh\s+run\s+download/,
  /pairing-relay-e2e\.yml/,
];
for (const ban of shellBans) {
  if (ban.test(e2eCode)) {
    errors.push(`e2e.yml must not retain cross-workflow pairing fetch (${ban})`);
  }
}

try {
  await access(removedPath);
  errors.push('standalone workflow still present: .github/workflows/pairing-relay-e2e.yml');
} catch {
  // expected — file deleted
}

if (errors.length) {
  for (const error of errors) console.error(`nightly-wiring: ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    'nightly-wiring: e2e.yml owns pairing lifecycle, ticket-hygiene, cross-network-relay, and mutation-testing; standalone pairing-relay-e2e removed',
  );
}
