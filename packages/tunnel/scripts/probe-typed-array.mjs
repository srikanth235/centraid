#!/usr/bin/env node

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const iroh = require('@number0/iroh/index.js');

function attempt(label, bytes) {
  try {
    const secret = iroh.SecretKey.fromBytes(bytes);
    return { label, accepted: true, returnedByteShape: secret.toBytes().constructor.name };
  } catch (error) {
    return {
      label,
      accepted: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const seed = Array.from({ length: 32 }, () => 1);
const results = [
  attempt('Array<number>', seed),
  attempt('Uint8Array', Uint8Array.from(seed)),
  attempt('Buffer', Buffer.from(seed)),
];

process.stdout.write(
  `${JSON.stringify(
    {
      schema: 'centraid-iroh-typed-array-probe/1',
      package: '@number0/iroh@1.0.0',
      api: 'SecretKey.fromBytes / SecretKey.toBytes',
      results,
    },
    null,
    2,
  )}\n`,
);

if (!results[0]?.accepted || results[1]?.accepted || results[2]?.accepted) process.exitCode = 1;
