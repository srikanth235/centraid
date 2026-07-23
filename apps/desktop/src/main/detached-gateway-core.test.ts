import { describe, expect, it } from 'vitest';
import {
  buildDetachedSpawnOptions,
  buildOwnershipStamp,
  buildStatusFile,
  canControl,
  DEFAULT_GATEWAY_PORT,
  DEFAULT_OFFER_GATEWAY_SERVICE,
  isProcessAlive,
  ownedGatewayNeedsRespawn,
  OWNERSHIP_FILE,
  resolveListenPort,
  shouldOfferServiceInstall,
  STATUS_FILE,
} from './detached-gateway-core.js';

const OUR_ID = 'desktop-owner-abc';
const OTHER_ID = 'cli-owner-xyz';

describe("canControl (H3 adopt-don't-kill)", () => {
  it('returns own when stamp ownerId matches', () => {
    const stamp = buildOwnershipStamp({
      owner: 'desktop',
      ownerId: OUR_ID,
      pid: 100,
    });
    expect(canControl(stamp, OUR_ID, { probeOk: true })).toBe('own');
    expect(canControl(stamp, OUR_ID, { probeOk: false })).toBe('own');
  });

  it('returns foreign when a different owner is live (probeOk)', () => {
    const stamp = buildOwnershipStamp({
      owner: 'cli',
      ownerId: OTHER_ID,
      pid: 200,
    });
    expect(canControl(stamp, OUR_ID, { probeOk: true })).toBe('foreign');
  });

  it('refuses reclaim when different owner and probe failed', () => {
    const stamp = buildOwnershipStamp({
      owner: 'service',
      ownerId: OTHER_ID,
      pid: 200,
    });
    expect(canControl(stamp, OUR_ID, { probeOk: false })).toBe('probe-failed-refuse');
  });

  it('returns foreign for missing stamp when something answers the probe', () => {
    expect(canControl(null, OUR_ID, { probeOk: true })).toBe('foreign');
    expect(canControl(undefined, OUR_ID, { probeOk: true })).toBe('foreign');
  });

  it('returns stale-reclaim for missing stamp when probe fails', () => {
    expect(canControl(null, OUR_ID, { probeOk: false })).toBe('stale-reclaim');
  });
});

describe('isProcessAlive', () => {
  it('rejects non-positive pids without calling checkFn', () => {
    let called = false;
    const check = () => {
      called = true;
      return true;
    };
    expect(isProcessAlive(0, check)).toBe(false);
    expect(isProcessAlive(-1, check)).toBe(false);
    expect(isProcessAlive(1.5, check)).toBe(false);
    expect(called).toBe(false);
  });

  it('delegates to the injectable checkFn', () => {
    const alive = new Set([42]);
    expect(isProcessAlive(42, (p) => alive.has(p))).toBe(true);
    expect(isProcessAlive(99, (p) => alive.has(p))).toBe(false);
  });
});

describe('resolveListenPort', () => {
  it('returns the stable default when unconfigured', () => {
    expect(resolveListenPort()).toBe(DEFAULT_GATEWAY_PORT);
    expect(resolveListenPort(undefined)).toBe(DEFAULT_GATEWAY_PORT);
  });

  it('rejects zero / negative / out-of-range and falls back to default', () => {
    expect(resolveListenPort(0)).toBe(DEFAULT_GATEWAY_PORT);
    expect(resolveListenPort(-1)).toBe(DEFAULT_GATEWAY_PORT);
    expect(resolveListenPort(70000)).toBe(DEFAULT_GATEWAY_PORT);
    expect(resolveListenPort(1.5)).toBe(DEFAULT_GATEWAY_PORT);
  });

  it('accepts a positive configured port', () => {
    expect(resolveListenPort(8765)).toBe(8765);
  });
});

describe('buildDetachedSpawnOptions (H2)', () => {
  it('describes detached + ignored stdio + unref', () => {
    expect(buildDetachedSpawnOptions()).toEqual({
      detached: true,
      stdio: 'ignore',
      unref: true,
    });
  });
});

describe('status / ownership helpers', () => {
  it('exports the on-disk filenames', () => {
    expect(OWNERSHIP_FILE).toBe('gateway.ownership.json');
    expect(STATUS_FILE).toBe('gateway.status.json');
  });

  it('builds ownership and status payloads', () => {
    const stamp = buildOwnershipStamp({
      owner: 'desktop',
      ownerId: OUR_ID,
      pid: 7,
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(stamp).toEqual({
      owner: 'desktop',
      ownerId: OUR_ID,
      pid: 7,
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    const status = buildStatusFile({
      host: '127.0.0.1',
      port: DEFAULT_GATEWAY_PORT,
      pid: 7,
      tokenFile: '/tmp/desktop-loopback-token.bin',
      renewedAt: '2026-01-01T00:00:01.000Z',
    });
    expect(status.url).toBe(`http://127.0.0.1:${DEFAULT_GATEWAY_PORT}`);
    expect(status.tokenFile).toBe('/tmp/desktop-loopback-token.bin');
  });
});

describe('ownedGatewayNeedsRespawn (stale-build refresh, #528 follow-up)', () => {
  it('never respawns when the freshness gate is off (adopt whatever is live)', () => {
    expect(ownedGatewayNeedsRespawn({ buildTag: 'old' }, 'new', false)).toBe(false);
    expect(ownedGatewayNeedsRespawn({ buildTag: undefined }, 'new', false)).toBe(false);
  });

  it('adopts when the build tag is unchanged — no needless restart', () => {
    expect(ownedGatewayNeedsRespawn({ buildTag: '1784800000000' }, '1784800000000', true)).toBe(
      false,
    );
  });

  it('respawns when the on-disk build tag differs (dev rebuild / prod update)', () => {
    expect(ownedGatewayNeedsRespawn({ buildTag: '1784800000000' }, '1784899999999', true)).toBe(
      true,
    );
  });

  it('respawns once when the stamp predates the buildTag field (self-establishing)', () => {
    expect(ownedGatewayNeedsRespawn({ buildTag: undefined }, 'new', true)).toBe(true);
  });
});

describe('shouldOfferServiceInstall (H5)', () => {
  it('defaults install off but offers the step during first-run onboarding', () => {
    expect(DEFAULT_OFFER_GATEWAY_SERVICE).toBe(false);
    // No decision + no onboarding stamp → show the opt-in step.
    expect(shouldOfferServiceInstall({})).toBe(true);
  });

  it('does not re-offer after the user decides or finishes onboarding', () => {
    expect(shouldOfferServiceInstall({ offerGatewayService: false })).toBe(false);
    expect(shouldOfferServiceInstall({ offerGatewayService: true })).toBe(false);
    expect(shouldOfferServiceInstall({ onboardingCompletedAt: '2026-07-20T00:00:00.000Z' })).toBe(
      false,
    );
  });
});
