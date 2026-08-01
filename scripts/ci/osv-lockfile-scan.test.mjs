import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  runOsvLockfileScan,
  summarizeOsvReport,
} from "./osv-lockfile-scan.mjs";

test("summarizeOsvReport classifies critical vs high from max_severity", () => {
  const report = {
    results: [
      {
        packages: [
          {
            package: { name: "crit-pkg", version: "1.0.0" },
            groups: [{ max_severity: "9.2", ids: ["GHSA-crit"] }],
            vulnerabilities: [],
          },
          {
            package: { name: "high-pkg", version: "2.0.0" },
            groups: [{ max_severity: "7.5", ids: ["GHSA-high"] }],
            vulnerabilities: [],
          },
          {
            package: { name: "low-pkg", version: "3.0.0" },
            groups: [{ max_severity: "3.2", ids: ["GHSA-low"] }],
            vulnerabilities: [],
          },
        ],
      },
    ],
  };
  const s = summarizeOsvReport(report);
  assert.equal(s.critical.length, 1);
  assert.match(s.critical[0], /crit-pkg@1\.0\.0/u);
  assert.equal(s.high.length, 1);
  assert.match(s.high[0], /high-pkg@2\.0\.0/u);
  assert.equal(s.totalPackages, 3);
});

test("summarizeOsvReport uses database_specific.severity CRITICAL", () => {
  const report = {
    results: [
      {
        packages: [
          {
            package: { name: "x", version: "0.1.0" },
            groups: [],
            vulnerabilities: [{ database_specific: { severity: "CRITICAL" } }],
          },
        ],
      },
    ],
  };
  const s = summarizeOsvReport(report);
  assert.equal(s.critical.length, 1);
});

test("runOsvLockfileScan against real bun.lock when osv-scanner is available", () => {
  let osv = process.env.OSV_SCANNER_BIN?.trim() || "";
  if (!osv) {
    const w = spawnSync("osv-scanner", ["--version"], { encoding: "utf8" });
    if (w.status === 0) osv = "osv-scanner";
  }
  if (!osv) {
    console.log("skip: osv-scanner binary not available");
    return;
  }
  const result = runOsvLockfileScan(osv);
  assert.ok(typeof result.table === "string");
  assert.ok(result.table.length > 0, "expected table output from osv-scanner");
  assert.ok(result.summary.totalPackages >= 0);
  assert.ok(result.code === 0 || result.code === 1);
});
