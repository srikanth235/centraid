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
];

const requiredArtifactNames = [
  'nightly-evidence-pairing-lifecycle',
  'nightly-evidence-pairing-ticket-hygiene',
  'nightly-evidence-pairing-cross-network-relay',
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
    'pairing-lifecycle',
    'pairing-ticket-hygiene',
    'pairing-cross-network-relay',
  ]) {
    if (!reportChunk.includes(need)) {
      errors.push(`test-health-report needs must include ${need}`);
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
    'nightly-wiring: e2e.yml owns pairing lifecycle, ticket-hygiene, and cross-network-relay; standalone pairing-relay-e2e removed',
  );
}
