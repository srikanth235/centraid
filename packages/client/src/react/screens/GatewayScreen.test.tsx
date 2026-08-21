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
  // THERE IS NO HERO WHILE THE GATEWAY IS ANSWERING (binding layer v11). The
  // panel used to open the page in every state and restate what the rest of it
  // already said — availability over a strip whose whole subject is
  // availability, uptime over an Identity row naming when the gateway started.
  // What survives is the page's status attribute, the head's cadence line, and
  // the Identity rows, and those are what this pins.
  it("states the gateway's condition without a hero while it is answering", () => {
    const html = render(base);
    expect(html).toContain("<h1>System</h1>");
    expect(html).toContain('data-status="up"');
    expect(html).toContain("heartbeat · every 5s");
    expect(html).toContain("local gateway · started");
    expect(html).toContain("3 ms last round trip");
    expect(html).toContain("99.2% this session"); // (720-6)/720
    // Server uptime figure ticks forward from the last heartbeat.
    expect(html).toContain("up 1h 01m 00s");
    // The word belongs to the down state alone; saying "Answering" over a page
    // that is visibly answering is the furniture v11 removed.
    expect(html).not.toContain("Answering");
  });

  it("draws the heartbeat strip — availability as a shape, named as this session", () => {
    const html = render(base);
    expect(html).toContain('data-testid="heartbeat-strip"');
    expect(html).toContain("did not answer");
    expect(html).toContain("1 of 3 heartbeats went unanswered");
    // The window is the ring we measured, never the handoff's thirty days.
    expect(html).toContain("This session only");
    expect(html).not.toContain("30 days");
  });

  it("omits the strip until three probes have landed", () => {
    const html = render({
      ...base,
      samples: [{ at: NOW - 5000, ok: true, latencyMs: 3 }],
    });
    expect(html).not.toContain('data-testid="heartbeat-strip"');
    // The Identity row still answers what one probe can answer — the strip is
    // a shape, the row is the number, and losing the shape does not lose the
    // fact.
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
    // The hero states what the gateway is doing and always leads; the arrival
    // row names the cause, and Backups is the next section — ahead of capacity.
    expect(html.indexOf("You arrived")).toBeLessThan(html.indexOf("Backups"));
    expect(html.indexOf("Backups")).toBeLessThan(html.indexOf("Capacity"));
  });

  it("leads with replica freshness and removes host-only restart for a viewer", () => {
    const html = renderToStaticMarkup(
      <GatewayScreen snapshot={base} now={NOW} {...stubProps} readOnly />
    );
    // Freshness is the app bar's and the status line's stamp now, not a panel
    // of its own: the head carries "checked Ns ago" on every seat.
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
    // Not "Limits": the limits panel draws only once a usage read lands, and
    // this render hands it a promise that never settles. Its read-only shape is
    // asserted where the data exists — StorageScreen.test.tsx.
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
    // Degraded is carried by the page's status attribute and by the section
    // that can act on it — never by a badge repeating the word. A component in
    // trouble is named where it broke.
    expect(html).toContain('data-status="degraded"');
    expect(html).not.toContain("Answering");
    // Heartbeat itself is still up — the uptime figure keeps ticking.
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
