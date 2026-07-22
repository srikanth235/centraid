#!/usr/bin/env node
/**
 * Report which release secret *names* are present in the environment.
 * Never prints secret values (issue #501 / docs/enrollment.md).
 *
 *   node scripts/release/verify-secrets.mjs [--strict]
 *
 * Exit 0 always unless --strict and a required name is missing.
 * In CI, secrets are injected as env vars by Actions — locally this reports
 * whatever is exported in the shell (usually all absent).
 */

const DESKTOP_APPLE = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
const DESKTOP_AZURE = [
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_CODE_SIGNING_ACCOUNT',
  'AZURE_CERT_PROFILE',
];
const MOBILE = [
  'EXPO_TOKEN',
  'EAS_PROJECT_ID',
  'CENTRAID_UPLOAD_STORE_FILE',
  'CENTRAID_UPLOAD_STORE_PASSWORD',
  'CENTRAID_UPLOAD_KEY_ALIAS',
  'CENTRAID_UPLOAD_KEY_PASSWORD',
];
const WEB = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'];

const groups = {
  'desktop-apple': DESKTOP_APPLE,
  'desktop-azure': DESKTOP_AZURE,
  mobile: MOBILE,
  web: WEB,
};

const strict = process.argv.includes('--strict');
const report = {};
let missingRequired = 0;

for (const [group, names] of Object.entries(groups)) {
  const rows = {};
  let present = 0;
  for (const name of names) {
    const ok = Boolean(process.env[name] && String(process.env[name]).length > 0);
    rows[name] = ok ? 'present' : 'absent';
    if (ok) present++;
  }
  report[group] = {
    present,
    total: names.length,
    ready: present === names.length,
    secrets: rows,
  };
}

console.log(JSON.stringify({ note: 'values never printed', groups: report }, null, 2));

if (strict) {
  // Strict only fails when nothing at all is enrolled for desktop (optional
  // until maintainer opts in). Use --strict-desktop-apple etc. later.
  for (const g of Object.values(report)) {
    if (!g.ready) missingRequired++;
  }
  if (missingRequired > 0) {
    console.error(
      `${missingRequired} secret group(s) incomplete — enrollment residual (docs/enrollment.md)`,
    );
    process.exit(1);
  }
}

process.exit(0);
