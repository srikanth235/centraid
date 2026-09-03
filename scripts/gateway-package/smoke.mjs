#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { waitForGatewayInfo } from "./probe.mjs";

const root = path.resolve(import.meta.dirname, "../..");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const baseUrlArg = arg("--base-url", null);

async function probeOnly(baseUrl) {
  const result = await waitForGatewayInfo(baseUrl, { deadlineMs: 45_000 });
  if (!result.ok) {
    process.stderr.write(
      `gateway smoke FAILED\nurl=${baseUrl}\n${result.detail}\n`
    );
    process.exit(1);
  }
  process.stdout.write(`gateway smoke OK ${baseUrl} ${result.detail}\n`);
}

async function hostMode() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "centraid-gw-smoke-"));
  const port = Number(arg("--port", "0"));
  const host = "127.0.0.1";
  const gatewayBin =
    arg("--gateway-bin", null) ??
    path.join(root, "packages/server/dist/cli/cli.js");

  const useBunSrc =
    !path.basename(gatewayBin).endsWith(".js") || gatewayBin.includes("cli.ts");

  mkdirSync(dataDir, { recursive: true });
  const logPath = path.join(dataDir, "smoke.log");
  const child = spawn(
    useBunSrc && gatewayBin.endsWith(".ts") ? "bun" : process.execPath,
    useBunSrc && gatewayBin.endsWith(".ts")
      ? [
          gatewayBin,
          "serve",
          "--data-dir",
          dataDir,
          "--host",
          host,
          "--port",
          String(port),
        ]
      : [
          gatewayBin,
          "serve",
          "--data-dir",
          dataDir,
          "--host",
          host,
          "--port",
          String(port || 18787),
        ],
    {
      cwd: root,
      env: { ...process.env, CENTRAID_SMOKE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  let output = "";
  child.stdout.on("data", (c) => {
    output += c.toString();
  });
  child.stderr.on("data", (c) => {
    output += c.toString();
  });

  let baseUrl = `http://${host}:${port || 18787}`;
  const deadline = Date.now() + 20_000;
  const waitForListener = async () => {
    if (Date.now() >= deadline) return;
    const m = output.match(/https?:\/\/127\.0\.0\.1:\d+/u);
    if (m) {
      baseUrl = m[0];
      return;
    }
    try {
      const early = await waitForGatewayInfo(baseUrl, {
        deadlineMs: 200,
        intervalMs: 50,
      });
      if (early.ok) return;
    } catch {
      // Intentionally empty.
    }
    await sleep(200);
    return waitForListener();
  };
  await waitForListener();

  const result = await waitForGatewayInfo(baseUrl, { deadlineMs: 10_000 });

  child.kill("SIGTERM");
  await sleep(500);
  try {
    child.kill("SIGKILL");
  } catch {
    // Intentionally empty.
  }

  writeFileSync(logPath, output);
  if (!result.ok) {
    process.stderr.write(
      `gateway smoke FAILED\nurl=${baseUrl}\n${result.detail}\n--- logs ---\n${output}\n`
    );
    rmSync(dataDir, { recursive: true, force: true });
    process.exit(1);
  }
  process.stdout.write(`gateway smoke OK ${baseUrl} ${result.detail}\n`);
  rmSync(dataDir, { recursive: true, force: true });
}

async function main() {
  if (baseUrlArg) {
    await probeOnly(baseUrlArg);
    return;
  }
  await hostMode();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exit(1);
});
