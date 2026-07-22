#!/usr/bin/env node
/**
 * Print the release surface matrix (issue #512).
 *
 *   node scripts/release/matrix.mjs [--json] [--surfaces a,b,c]
 */
import { buildSurfaceMatrix, defaultShipSurfaceIds, resolveShipSurfaces } from './surfaces.mjs';

function parseArgs(argv) {
  let json = false;
  /** @type {string[] | null} */
  let shipIds = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') json = true;
    else if (argv[i] === '--surfaces') {
      const raw = argv[++i] ?? '';
      shipIds = raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(
        'Usage: node scripts/release/matrix.mjs [--json] [--surfaces desktop,gateway-npm]',
      );
      process.exit(0);
    }
  }
  return { json, shipIds };
}

const { json, shipIds } = parseArgs(process.argv.slice(2));
if (shipIds) {
  const r = resolveShipSurfaces(shipIds);
  if (!r.ok) {
    console.error(r.error);
    process.exit(2);
  }
}

const matrix = buildSurfaceMatrix({ shipIds: shipIds ?? defaultShipSurfaceIds() });

if (json) {
  console.log(JSON.stringify(matrix, null, 2));
  process.exit(0);
}

console.log('Centraid release surfaces (#512)\n');
console.log(matrix.productVersionRule);
console.log(matrix.protocolRule);
console.log(matrix.buildNumberRule);
console.log('');
console.log(`Default ship on v*: ${matrix.defaultShip.join(', ')}`);
console.log(`This cycle:         ${matrix.shipThisCycle.join(', ')}`);
console.log('');
console.log(
  'id'.padEnd(16) + 'cadence'.padEnd(12) + 'default'.padEnd(10) + 'ship?'.padEnd(8) + 'workflow',
);
console.log('-'.repeat(72));
for (const s of matrix.surfaces) {
  console.log(
    s.id.padEnd(16) +
      s.cadence.padEnd(12) +
      (s.inDefaultShip ? 'yes' : 'no').padEnd(10) +
      (s.inThisShip ? 'yes' : 'no').padEnd(8) +
      (s.workflow ?? '—'),
  );
}
console.log('\nNotes:');
for (const s of matrix.surfaces) {
  console.log(`  ${s.id}: ${s.notes}`);
}
