import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ResourceReceiptPanel from './ResourceReceiptPanel.js';
import type { ResourceUsageDTO } from './resource-summary.js';

const usage: ResourceUsageDTO = {
  sinceMs: Date.now() - 2 * 3_600_000,
  process: {
    cpuSecondsTotal: 125,
    currentRssBytes: 268_435_456, // 256 MB
    peakRssBytes: 402_653_184, // 384 MB
  },
  subsystems: {
    workerPool: { tasks: 42, busyMs: 3400 },
    replication: { passes: 3, bytesReplicated: 15_728_640, busyMs: 1200 }, // 15 MB
    backup: { drains: 1, bytesUploaded: 1_048_576, busyMs: 800 }, // 1 MB
    sweeps: { passes: 12, busyMs: 450 },
    agentRuns: { runs: 7, busyMs: 21_000, cpuSeconds: null },
  },
  backgroundTimerFiresLastHour: 240,
};

describe('ResourceReceiptPanel (#528 Phase C)', () => {
  it('renders the accounting window and gateway-host attribution', () => {
    const html = renderToStaticMarkup(<ResourceReceiptPanel usage={usage} />);
    expect(html).toContain('Resource receipt');
    expect(html).toContain('since ');
    expect(html).toContain('gateway host');
  });

  it('renders process actuals with sane byte + duration formatting', () => {
    const html = renderToStaticMarkup(<ResourceReceiptPanel usage={usage} />);
    expect(html).toContain('CPU time');
    expect(html).toContain('2.1 min'); // 125 CPU-seconds
    expect(html).toContain('Memory now');
    expect(html).toContain('256 MB');
    expect(html).toContain('Peak memory');
    expect(html).toContain('384 MB');
  });

  it('renders every subsystem row with measured proxies', () => {
    const html = renderToStaticMarkup(<ResourceReceiptPanel usage={usage} />);
    expect(html).toContain('Worker pool');
    expect(html).toContain('42 tasks');
    expect(html).toContain('3.4s active');
    expect(html).toContain('Replication');
    expect(html).toContain('15 MB');
    expect(html).toContain('Backup');
    expect(html).toContain('1.0 MB uploaded');
    expect(html).toContain('Sweeps');
    expect(html).toContain('12 passes');
    expect(html).toContain('Agent runs');
    expect(html).toContain('7 runs');
  });

  it('labels agent runs as measured but not governed by Conserve', () => {
    const html = renderToStaticMarkup(<ResourceReceiptPanel usage={usage} />);
    expect(html).toContain('not limited by Conserve');
  });

  it('shows background wakeups when tracked, and the no-watts honesty note', () => {
    const html = renderToStaticMarkup(<ResourceReceiptPanel usage={usage} />);
    expect(html).toContain('Background wakeups (last hour)');
    expect(html).toContain('240');
    expect(html).toContain('watts');
  });

  it('omits the wakeups row when the count is null', () => {
    const html = renderToStaticMarkup(
      <ResourceReceiptPanel usage={{ ...usage, backgroundTimerFiresLastHour: null }} />,
    );
    expect(html).not.toContain('Background wakeups');
  });

  it('renders a quiet unavailable line when no usage is present', () => {
    const html = renderToStaticMarkup(<ResourceReceiptPanel />);
    expect(html).toContain('Resource receipt');
    expect(html).toContain('Not available from this gateway');
    expect(html).not.toContain('watts');
  });
});
