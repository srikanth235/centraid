#!/usr/bin/env node
/**
 * E5 — lockfile supply-chain lint (https-only, allowed hosts, integrity present).
 * Reads bun.lock as text; fails on clear violations.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const lock = readFileSync(path.join(root, 'bun.lock'), 'utf8');
const allowedHost = /registry\.npmjs\.org|npm\.pkg\.github\.com|bun\.sh/;
let failed = 0;

// HTTP (non-TLS) package URLs
const httpUrls = lock.match(/http:\/\/[^\s"']+/g) ?? [];
for (const u of httpUrls) {
  if (u.includes('localhost') || u.includes('127.0.0.1')) continue;
  console.error(`FAIL http (non-TLS) URL in lockfile: ${u}`);
  failed++;
}

// Integrity-ish tokens should appear for resolved packages (bun uses integrity fields)
if (!/integrity|sha512-|sha256-/.test(lock)) {
  console.error('FAIL lockfile has no integrity/hash markers');
  failed++;
}

// Suspicious hosts outside allowlist (best-effort on https:// URLs)
const httpsUrls = lock.match(/https:\/\/([^/\s"']+)/g) ?? [];
for (const full of httpsUrls) {
  const host = full.replace('https://', '');
  if (
    !allowedHost.test(host) &&
    !host.includes('github.com') &&
    !host.includes('githubusercontent.com')
  ) {
    // Only warn on unknown package registries; many raw github tarballs are fine.
    if (host.includes('registry') || host.includes('npm')) {
      console.error(`FAIL disallowed registry host: ${host}`);
      failed++;
    }
  }
}

if (failed > 0) {
  console.error(`lockfile-lint: ${failed} issue(s)`);
  process.exit(1);
}
console.log('lockfile-lint: ok');
