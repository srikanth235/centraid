import { describe, expect, it } from 'vitest';

import {
  applyProbeOutcome,
  buildGatewayRows,
  type GatewayProbeCache,
  type RegistryGateway,
} from './gatewayRegistry.js';

// The gateway switcher is the ONE switcher that survived Decision 14 (#599).
// These are the pure halves: what a probe does to the cache, and what the rows
// say once it has.

const gateways: RegistryGateway[] = [
  { gatewayId: 'local', gatewayKind: 'local', gatewayLabel: 'This Mac' },
  {
    gatewayId: 'office',
    gatewayKind: 'remote',
    gatewayLabel: 'Office',
    hasSsh: true,
  },
  { gatewayId: 'attic', gatewayKind: 'remote', gatewayLabel: 'Attic' },
];

describe(applyProbeOutcome, () => {
  it('keeps the last known count across a refresh that is still in flight', () => {
    let cache: GatewayProbeCache = {};
    cache = applyProbeOutcome(cache, 'local', {
      status: 'ready',
      spaceCount: 3,
    });
    cache = applyProbeOutcome(cache, 'local', { status: 'loading' });
    expect(cache.local).toStrictEqual({ spaceCount: 3, status: 'loading' });
  });

  it('keeps the last known count across a FAILED refresh — a blip must not blank data', () => {
    let cache: GatewayProbeCache = {};
    cache = applyProbeOutcome(cache, 'local', {
      status: 'ready',
      spaceCount: 2,
    });
    cache = applyProbeOutcome(cache, 'local', {
      status: 'error',
      error: 'unreachable',
    });
    expect(cache.local).toMatchObject({
      spaceCount: 2,
      status: 'error',
      error: 'unreachable',
    });
  });

  it('replaces the count only on a successful probe', () => {
    let cache: GatewayProbeCache = {};
    cache = applyProbeOutcome(cache, 'local', {
      status: 'ready',
      spaceCount: 2,
    });
    cache = applyProbeOutcome(cache, 'local', {
      status: 'ready',
      spaceCount: 5,
    });
    expect(cache.local?.spaceCount).toBe(5);
  });
});

describe(buildGatewayRows, () => {
  it('puts the active gateway first and sorts the rest by name', () => {
    const rows = buildGatewayRows(gateways, {}, 'office');
    expect(rows.map((r) => r.gatewayId)).toStrictEqual(['office', 'attic', 'local']);
    expect(rows[0]!.isActive).toBe(true);
  });

  it('badges transport from the profile — SSH only when the gateway has one', () => {
    const rows = buildGatewayRows(gateways, {}, 'local');
    const badge = (id: string): string => rows.find((r) => r.gatewayId === id)!.transportBadge;
    expect(badge('local')).toBe('This Mac');
    expect(badge('office')).toBe('SSH');
    expect(badge('attic')).toBe('iroh');
  });

  it('reports a gateway with no probe yet as loading, not as broken', () => {
    const rows = buildGatewayRows(gateways, {}, 'local');
    expect(rows.every((r) => r.status === 'loading')).toBe(true);
    expect(rows.every((r) => r.spaceCount === undefined)).toBe(true);
  });

  it('surfaces the probe error verbatim so the row can say WHY', () => {
    const cache = applyProbeOutcome({}, 'attic', {
      status: 'error',
      error: 'auth_failed',
    });
    const row = buildGatewayRows(gateways, cache, 'local').find((r) => r.gatewayId === 'attic')!;
    expect(row.status).toBe('auth_failed');
  });

  it('refuses to offer removal of the local gateway — it is the primordial one', () => {
    const rows = buildGatewayRows(gateways, {}, 'local');
    expect(rows.find((r) => r.gatewayId === 'local')!.canRemove).toBe(false);
    expect(rows.find((r) => r.gatewayId === 'office')!.canRemove).toBe(true);
  });

  it('carries the space count through once a probe lands', () => {
    const cache = applyProbeOutcome({}, 'local', {
      status: 'ready',
      spaceCount: 4,
    });
    const row = buildGatewayRows(gateways, cache, 'local')[0]!;
    expect(row.status).toBe('ready');
    expect(row.spaceCount).toBe(4);
  });
});
