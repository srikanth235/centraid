import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RELEASE_SURFACES,
  buildSurfaceMatrix,
  defaultShipSurfaceIds,
  resolveShipSurfaces,
} from './surfaces.mjs';

test('default ship is tag surfaces only (not mobile/web)', () => {
  const ids = defaultShipSurfaceIds();
  assert.ok(ids.includes('desktop'));
  assert.ok(ids.includes('gateway-image'));
  assert.ok(ids.includes('gateway-npm'));
  assert.ok(!ids.includes('mobile'));
  assert.ok(!ids.includes('web'));
});

test('resolveShipSurfaces rejects unknown ids', () => {
  const bad = resolveShipSurfaces(['desktop', 'nope']);
  assert.equal(bad.ok, false);
  const good = resolveShipSurfaces(['desktop', 'mobile']);
  assert.equal(good.ok, true);
  if (good.ok) assert.equal(good.surfaces.length, 2);
});

test('buildSurfaceMatrix marks ship set', () => {
  const m = buildSurfaceMatrix({ shipIds: ['mobile'] });
  assert.deepEqual(m.shipThisCycle, ['mobile']);
  const mobile = m.surfaces.find((s) => s.id === 'mobile');
  assert.equal(mobile?.inThisShip, true);
  assert.equal(m.surfaces.find((s) => s.id === 'desktop')?.inThisShip, false);
});

test('catalog ids unique', () => {
  const ids = RELEASE_SURFACES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
});
