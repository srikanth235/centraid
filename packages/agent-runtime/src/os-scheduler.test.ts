import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLaunchdPlist,
  buildSystemdService,
  buildSystemdTimer,
  cronToLaunchdIntervals,
  cronToSchtasksArgs,
  cronToSystemdOnCalendar,
  jobLabel,
} from './os-scheduler.js';

const baseSpec = {
  automationId: 'auto-xyz',
  automationName: 'daily-digest',
  cronExprs: ['0 9 * * *'],
  cwd: '/var/centraid/work',
  runner: 'codex' as const,
  centraidBin: '/usr/local/bin/centraid',
};

describe('cronToLaunchdIntervals', () => {
  it('emits a single entry for daily-at-9AM', () => {
    const intervals = cronToLaunchdIntervals('0 9 * * *');
    assert.equal(intervals.length, 1);
    assert.deepEqual(intervals[0], { Minute: 0, Hour: 9 });
  });

  it('expands every-30-min into two entries (Minute 0 / Minute 30)', () => {
    const intervals = cronToLaunchdIntervals('*/30 * * * *');
    assert.equal(intervals.length, 2);
    assert.deepEqual(
      intervals.map((i) => i.Minute).sort((a, b) => a - b),
      [0, 30],
    );
  });

  it('expands ranges into individual entries', () => {
    const intervals = cronToLaunchdIntervals('0 9-11 * * *');
    assert.equal(intervals.length, 3);
    assert.deepEqual(
      intervals.map((i) => i.Hour).sort((a, b) => a - b),
      [9, 10, 11],
    );
  });

  it('rejects unsupported field shapes', () => {
    assert.throws(() => cronToLaunchdIntervals('0 9 * * MON'), /unsupported/);
  });
});

describe('buildLaunchdPlist', () => {
  it('emits a plist with the canonical structure', () => {
    const plist = buildLaunchdPlist(baseSpec);
    assert.match(plist, /<key>Label<\/key>/);
    assert.match(plist, /com\.centraid\.auto-xyz/);
    assert.match(plist, /<string>run-automation<\/string>/);
    assert.match(plist, /<string>auto-xyz<\/string>/);
    assert.match(plist, /<string>--runner<\/string>/);
    assert.match(plist, /<string>codex<\/string>/);
    assert.match(plist, /<key>StartCalendarInterval<\/key>/);
    assert.match(plist, /<key>Hour<\/key>\s*<integer>9<\/integer>/);
  });

  it('emits an <array> wrapper when cron expands to multiple intervals', () => {
    const plist = buildLaunchdPlist({ ...baseSpec, cronExprs: ['*/30 * * * *'] });
    assert.match(plist, /<array>/);
    assert.match(plist, /<integer>0<\/integer>[\s\S]*<integer>30<\/integer>/);
  });

  it('folds multiple cron triggers into one plist', () => {
    const plist = buildLaunchdPlist({ ...baseSpec, cronExprs: ['0 9 * * *', '0 17 * * *'] });
    assert.match(plist, /<array>/);
    assert.match(plist, /<integer>9<\/integer>[\s\S]*<integer>17<\/integer>/);
  });

  it('folds multiple cron triggers into one systemd timer', () => {
    const timer = buildSystemdTimer({ ...baseSpec, cronExprs: ['0 9 * * *', '0 17 * * *'] });
    assert.equal(timer.match(/OnCalendar=/g)?.length, 2);
  });
});

describe('cronToSystemdOnCalendar', () => {
  it('renders a daily 9AM schedule', () => {
    assert.equal(cronToSystemdOnCalendar('0 9 * * *'), '*-*-* 9:0:00');
  });

  it('renders an every-30-min schedule', () => {
    assert.equal(cronToSystemdOnCalendar('*/30 * * * *'), '*-*-* *:0/30:00');
  });
});

describe('buildSystemdService / buildSystemdTimer', () => {
  it('emits an ExecStart line with the centraid invocation', () => {
    const service = buildSystemdService(baseSpec);
    assert.match(
      service,
      /ExecStart=\/usr\/local\/bin\/centraid run-automation auto-xyz --runner codex/,
    );
    assert.match(service, /WorkingDirectory=\/var\/centraid\/work/);
  });

  it('emits a timer pointing at the matching service unit', () => {
    const timer = buildSystemdTimer(baseSpec);
    assert.match(timer, /OnCalendar=\*-\*-\* 9:0:00/);
    assert.match(timer, /Unit=com\.centraid\.auto-xyz\.service/);
    assert.match(timer, /Persistent=true/);
  });
});

describe('cronToSchtasksArgs', () => {
  it('translates every-N-min to /SC MINUTE /MO N', () => {
    assert.deepEqual(cronToSchtasksArgs('*/15 * * * *'), ['/SC', 'MINUTE', '/MO', '15']);
  });

  it('translates daily HH:MM to /SC DAILY /ST HH:MM', () => {
    assert.deepEqual(cronToSchtasksArgs('30 9 * * *'), ['/SC', 'DAILY', '/ST', '09:30']);
  });

  it('refuses expressions it cannot model', () => {
    assert.throws(() => cronToSchtasksArgs('0 9 * * MON'), /cannot be represented/);
  });
});

describe('jobLabel', () => {
  it('sanitizes the automation id into a launchd-safe label', () => {
    assert.equal(jobLabel('auto-xyz'), 'com.centraid.auto-xyz');
    assert.equal(jobLabel('weird.id/chars'), 'com.centraid.weird_id_chars');
  });
});
