// The refcount guarding the Android foreground service (F8): concurrent owners
// must not tear it down under one another, and a non-owner poke is a no-op.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = { start: vi.fn(), update: vi.fn(), stop: vi.fn() };

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  NativeModules: { CentraidUploadForeground: native },
}));

let UploadForegroundService: typeof import('./foreground-service').UploadForegroundService;

beforeEach(async () => {
  native.start.mockClear();
  native.update.mockClear();
  native.stop.mockClear();
  // Re-import fresh so the module-level refcount resets between cases.
  vi.resetModules();
  ({ UploadForegroundService } = await import('./foreground-service'));
});

afterEach(() => vi.clearAllMocks());

describe('UploadForegroundService refcount', () => {
  it('starts the native service once and stops it once across a single owner', () => {
    UploadForegroundService.start(3);
    UploadForegroundService.stop();
    expect(native.start).toHaveBeenCalledTimes(1);
    expect(native.stop).toHaveBeenCalledTimes(1);
  });

  it('keeps the service alive until the LAST concurrent owner stops', () => {
    UploadForegroundService.start(2);
    UploadForegroundService.start(5);
    expect(native.start, 'started once, not per owner').toHaveBeenCalledTimes(1);

    UploadForegroundService.stop();
    expect(native.stop, 'first stop must not tear down the live drain').not.toHaveBeenCalled();
    UploadForegroundService.stop();
    expect(native.stop).toHaveBeenCalledTimes(1);
  });

  it('treats start(0) as a no-op and never underflows on an unowned stop', () => {
    UploadForegroundService.start(0);
    UploadForegroundService.stop();
    UploadForegroundService.update(1, 2);
    expect(native.start).not.toHaveBeenCalled();
    expect(native.stop).not.toHaveBeenCalled();
    expect(native.update, 'no update without an owner').not.toHaveBeenCalled();
  });

  it('forwards progress only while an owner holds the service', () => {
    UploadForegroundService.start(4);
    UploadForegroundService.update(2, 4);
    expect(native.update).toHaveBeenCalledWith(2, 4);
    UploadForegroundService.stop();
    UploadForegroundService.update(3, 4);
    expect(native.update, 'no update after the owner released').toHaveBeenCalledTimes(1);
  });
});
