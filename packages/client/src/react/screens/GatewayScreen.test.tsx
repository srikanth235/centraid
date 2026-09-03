import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  backupProps,
  base,
  makeHealth,
  NOW,
  render,
  stubProps,
} from "./GatewayScreen.fixtures.js";
import GatewayScreen from "./GatewayScreen.js";

describe("GatewayScreen — Overview tab (default)", () => {
  it("states the gateway's condition without a hero while it is answering", () => {
    const html = render(base);
    expect(html).toContain("<h1>System</h1>");
    expect(html).toContain('data-status="up"');
    expect(html).toContain("heartbeat · every 5s");
    expect(html).toContain("local gateway · started");
    expect(html).toContain("3 ms last round trip");
    expect(html).toContain("99.2% this session"); // (720-6)/720
    expect(html).toContain("up 1h 01m 00s");
    expect(html).not.toContain("Answering");
  });

  it("draws the heartbeat strip — availability as a shape, named as this session", () => {
    const html = render(base);
    expect(html).toContain('data-testid="heartbeat-strip"');
    expect(html).toContain("did not answer");
    expect(html).toContain("1 of 3 heartbeats went unanswered");
    expect(html).toContain("This session only");
    expect(html).not.toContain("30 days");
  });

  it("omits the strip until three probes have landed", () => {
    const html = render({
      ...base,
      samples: [{ at: NOW - 5000, ok: true, latencyMs: 3 }],
    });
    expect(html).not.toContain('data-testid="heartbeat-strip"');
    expect(html).toContain("720 run · 6 failed");
    expect(html).toContain("99.2% this session");
  });

  it("keeps the overview free of tabs and offers drill-in pages", () => {
    const html = render(base);
    expect(html).not.toContain('role="tablist"');
    expect(html).toContain("Components");
    expect(html).toContain("Logs");
    expect(html).toContain("Alert history");
  });

  it("keeps backup and recovery controls on Overview", () => {
    const html = renderToStaticMarkup(
      <GatewayScreen
        snapshot={base}
        now={NOW}
        {...stubProps}
        backup={backupProps}
      />
    );
    expect(html).toContain("Backups");
  });

  it("carries backup-alert arrival copy and orders Backups first", () => {
    const html = renderToStaticMarkup(
      <GatewayScreen
        snapshot={base}
        now={NOW}
        {...stubProps}
        backup={backupProps}
        cause="backup-alert"
        focus="backups"
        loadLocalUsage={() => new Promise(() => {})}
        saveStorageLimits={() => new Promise(() => {})}
      />
    );
    expect(html).toContain("You arrived from the backup alert");
    expect(html.indexOf("You arrived")).toBeLessThan(html.indexOf("Backups"));
    expect(html.indexOf("Backups")).toBeLessThan(html.indexOf("Capacity"));
  });

  it("leads with replica freshness and removes host-only restart for a viewer", () => {
    const html = renderToStaticMarkup(
      <GatewayScreen snapshot={base} now={NOW} {...stubProps} readOnly />
    );
    expect(html).toContain("heartbeat · every 5s · checked");
    expect(html).toContain("Runs on Local");
    expect(html).toContain("restarting the gateway is done on that machine");
    expect(html).toContain("Components");
    expect(html).toContain("Logs");
    expect(html).toContain("Alert history");
    expect(html).not.toContain("Restart gateway");
    expect(html).not.toContain("System · Back");
  });

  it("keeps viewer backup and capacity summaries on Overview without verbs", () => {
    const html = renderToStaticMarkup(
      <GatewayScreen
        snapshot={base}
        now={NOW}
        {...stubProps}
        backup={backupProps}
        loadLocalUsage={() => new Promise(() => {})}
        saveStorageLimits={() => new Promise(() => {})}
        readOnly
      />
    );
    expect(html).toContain("Backups");
    expect(html).toContain("Capacity");
    expect(html).not.toContain("Back up now");
    expect(html).not.toContain("Rescan");
    expect(html).not.toContain(">Set<");
  });

  it("states the live session denominator without inventing 30-day history", () => {
    const html = render(base);
    expect(html).toContain("720 run · 6 failed");
    expect(html).toContain("99.2% this session");
    expect(html).not.toContain("30 days");
    expect(html).not.toContain("Outage log");
  });

  it("renders the unreachable state with the failure detail and blanked gauges", () => {
    const html = render({
      ...base,
      status: "down",
      statusSince: NOW - 30_000,
      lastError: "fetch failed",
      outages: [...base.outages, { startedAt: NOW - 30_000 }],
    });
    expect(html).toContain("Not answering");
    expect(html).toContain('data-status="down"');
    expect(html).toContain("fetch failed");
    expect(html).not.toContain("1h 01m 00s"); // uptime blanks while down
  });

  it('reconciles a healthy heartbeat with a failing component into "Degraded"', () => {
    const html = render(base, makeHealth({ status: "error" }));
    expect(html).toContain('data-status="degraded"');
    expect(html).not.toContain("Answering");
    expect(html).toContain("1h 01m 00s");
  });

  it("lets the heartbeat win when the process is unreachable, even with healthy components", () => {
    const html = render(
      { ...base, status: "down" },
      makeHealth({ status: "ok" })
    );
    expect(html).toContain("Not answering");
    expect(html).toContain('data-status="down"');
  });
});
