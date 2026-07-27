import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CRON_DEFAULT_TIMEZONE_PREF,
  loadDefaultCronTimeZone,
  saveDefaultCronTimeZone,
} from './settingsCronTimezoneData.js';

const getUserPrefs = vi.hoisted(() => vi.fn());
const saveUserPrefs = vi.hoisted(() => vi.fn());

vi.mock('../../../gateway-client.js', () => ({
  getUserPrefs: () => getUserPrefs(),
  saveUserPrefs: (patch: Record<string, unknown>) => saveUserPrefs(patch),
}));

beforeEach(() => {
  getUserPrefs.mockReset();
  saveUserPrefs.mockReset();
  getUserPrefs.mockResolvedValue({});
  saveUserPrefs.mockResolvedValue({});
});

describe('settingsCronTimezoneData', () => {
  it('loads the gateway default cron timezone pref', async () => {
    getUserPrefs.mockResolvedValue({ [CRON_DEFAULT_TIMEZONE_PREF]: 'America/New_York' });
    await expect(loadDefaultCronTimeZone()).resolves.toBe('America/New_York');
  });

  it('returns empty string when the pref is unset', async () => {
    await expect(loadDefaultCronTimeZone()).resolves.toBe('');
  });

  it('saves a valid IANA name', async () => {
    await expect(saveDefaultCronTimeZone('Europe/London')).resolves.toBeNull();
    expect(saveUserPrefs).toHaveBeenCalledWith({
      [CRON_DEFAULT_TIMEZONE_PREF]: 'Europe/London',
    });
  });

  it('clears the pref when empty', async () => {
    await expect(saveDefaultCronTimeZone('  ')).resolves.toBeNull();
    expect(saveUserPrefs).toHaveBeenCalledWith({
      [CRON_DEFAULT_TIMEZONE_PREF]: null,
    });
  });

  it('refuses an unknown IANA name without writing', async () => {
    const err = await saveDefaultCronTimeZone('Not/A_Zone');
    expect(err).toMatch(/not a known IANA timezone/);
    expect(saveUserPrefs).not.toHaveBeenCalled();
  });
});
