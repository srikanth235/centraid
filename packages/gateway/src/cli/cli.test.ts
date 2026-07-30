import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import url from "node:url";

import { describe, afterEach, beforeEach, expect, test } from "vitest";

import type { PrefsStore } from "@centraid/app-engine";
import { tempDir } from "@centraid/test-kit/temp-dir";

// Also name the pure helper module so cold-spot reachability is unambiguous.
import { parseServeArgsPure as pureFromHelper } from "./cli-serve-args.ts";
import {
  isProcessMainModule,
  parseServeArgsPure,
  timingSafeTokenEqual,
} from "./cli.ts";
import { validateConfig, DaemonConfigError } from "./config.ts";
import { platformDefaultDataDir } from "./data-dir.ts";
import { daemonLayoutFor } from "./paths.ts";
import { buildPrefsPatch, seedRunnerPrefs } from "./runner-prefs.ts";

const here = import.meta.dirname;
const CLI_TS = path.resolve(here, "cli.ts");
const TSX_BIN = path.resolve(
  here,
  "..",
  "..",
  "..",
  "node_modules",
  ".bin",
  "tsx"
);

let dataDir: string;

describe("cli scenarios", () => {
  beforeEach(async () => {
    dataDir = await tempDir(`centraid-gateway-${crypto.randomUUID()}-`);
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("parseServeArgsPure accepts host/port/data-dir/allowed-host flags", () => {
    const parsed = parseServeArgsPure([
      "--data-dir",
      "/tmp/x",
      "--host",
      "0.0.0.0",
      "--port",
      "8765",
      "--allowed-host",
      "gateway.local",
      "--allowed-host",
      "other.local",
      "--config",
      "/tmp/cfg.json",
    ]);
    expect(parsed).toStrictEqual({
      ok: true,
      value: {
        dataDir: "/tmp/x",
        host: "0.0.0.0",
        port: 8765,
        allowedHosts: ["gateway.local", "other.local"],
        configPath: "/tmp/cfg.json",
      },
    });
  });

  test("platform default data dir stays outside app userData conventions", () => {
    expect(
      platformDefaultDataDir({
        platform: "darwin",
        homeDir: "/Users/alice",
        env: {},
      })
    ).toBe("/Users/alice/Library/Application Support/centraid/gateway");
    expect(
      platformDefaultDataDir({
        platform: "linux",
        homeDir: "/home/alice",
        env: {},
      })
    ).toBe("/home/alice/.local/share/centraid/gateway");
    expect(
      platformDefaultDataDir({
        platform: "win32",
        homeDir: "C:\\Users\\alice",
        env: { LOCALAPPDATA: "D:\\Local" },
      })
    ).toBe(path.join("D:\\Local", "Centraid", "gateway"));
  });

  test("parseServeArgsPure rejects bad port, missing values, and unknown flags", () => {
    expect(parseServeArgsPure(["--port", "99999"])).toStrictEqual({
      ok: false,
      message: '--port must be an integer in [0, 65535], got "99999"',
      code: 2,
    });
    expect(parseServeArgsPure(["--data-dir"])).toStrictEqual({
      ok: false,
      message: 'flag "--data-dir" requires a value',
      code: 2,
    });
    expect(parseServeArgsPure(["--allowed-host", "  "])).toStrictEqual({
      ok: false,
      message: "--allowed-host requires a hostname",
      code: 2,
    });
    expect(parseServeArgsPure(["--nope"])).toStrictEqual({
      ok: false,
      message: 'unknown flag "--nope"',
      code: 2,
    });
    expect(parseServeArgsPure(["--help"])).toStrictEqual({
      ok: false,
      help: true,
    });
  });

  test("timingSafeTokenEqual matches equal secrets and rejects length/content mismatches", () => {
    expect(timingSafeTokenEqual("abc", "abc")).toBe(true);
    expect(timingSafeTokenEqual("abc", "abd")).toBe(false);
    expect(timingSafeTokenEqual("abc", "ab")).toBe(false);
    // Re-export from the entrypoint matches the pure helper module.
    expect(pureFromHelper(["--port", "1"])).toStrictEqual(
      parseServeArgsPure(["--port", "1"])
    );
  });

  test("isProcessMainModule realpaths symlink argv so Node bin install is not a silent no-op", async () => {
    const linkDir = await tempDir("cli-main-symlink-");
    const linkPath = path.join(linkDir, "centraid-gateway");
    await fs.symlink(CLI_TS, linkPath);
    expect(isProcessMainModule(linkPath, url.pathToFileURL(CLI_TS))).toBe(true);
    expect(isProcessMainModule(CLI_TS, url.pathToFileURL(CLI_TS))).toBe(true);
    expect(isProcessMainModule(undefined, url.pathToFileURL(CLI_TS))).toBe(
      false
    );
    expect(
      isProcessMainModule(
        path.join(linkDir, "other.ts"),
        url.pathToFileURL(CLI_TS)
      )
    ).toBe(false);
    await fs.rm(linkDir, { recursive: true, force: true });
  });

  test("validateConfig rejects missing dataDir", () => {
    expect(() => validateConfig({})).toThrow(DaemonConfigError);
  });

  test("validateConfig rejects out-of-range port", () => {
    expect(() => validateConfig({ dataDir: "/tmp/x", port: 99999 })).toThrow(
      /must be an integer/u
    );
  });

  test("validateConfig accepts a minimal config and a fully populated one", () => {
    expect(validateConfig({ dataDir: "/tmp/x" })).toStrictEqual({
      dataDir: "/tmp/x",
    });
    const full = validateConfig({
      dataDir: "/tmp/x",
      host: "0.0.0.0",
      port: 8765,
      runner: {
        kind: "codex",
        binPath: "/opt/bin/codex",
        extraArgs: ["--foo"],
      },
    });
    expect(full.runner?.kind).toBe("codex");
    expect(full.runner?.binPath).toBe("/opt/bin/codex");
  });

  test("buildPrefsPatch clears every runner key when no runner is configured", () => {
    const patch = buildPrefsPatch({ dataDir: "/x" });
    // No runner → every key must clear to null so a removed entry in the
    // config file actually wipes the DB.
    for (const v of Object.values(patch)) expect(v).toBeNull();
  });

  test("buildPrefsPatch sets only the keys the config carries", () => {
    const patch = buildPrefsPatch({
      dataDir: "/x",
      runner: { kind: "claude-code" },
    });
    expect(patch["agent.runner.kind"]).toBe("claude-code");
    expect(patch["agent.runner.binPath"]).toBeNull();
    expect(patch["agent.runner.extraArgs"]).toBeNull();
  });

  test("seedRunnerPrefs calls setPrefs even on empty config so a removed runner is cleared", () => {
    // Regression: an early `if (!runner) return` would skip setPrefs entirely
    // when the block is absent, leaving a previously seeded `agent.runner.*`
    // row stale across reboots.
    const patches: Array<Record<string, unknown>> = [];
    const fakeStore = {
      setPrefs(p: Record<string, unknown>) {
        patches.push(p);
        return p;
      },
    } as unknown as PrefsStore;
    seedRunnerPrefs(fakeStore, { dataDir: "/x" });
    expect(patches).toHaveLength(1);
    for (const v of Object.values(patches[0]!)) expect(v).toBeNull();
  });

  test("daemonLayoutFor resolves relative paths to absolute", () => {
    const layout = daemonLayoutFor("./relative");
    expect(path.isAbsolute(layout.gatewayDbFile)).toBeTruthy();
    expect(
      layout.gatewayDbFile.endsWith(path.join("relative", "gateway.db"))
    ).toBeTruthy();
  });

  test("daemonLayoutFor mounts the vault plane at <dataDir>/vault", () => {
    // The daemon is a real host (duaility §12): a missing vaultDir would
    // leave every projection blueprint dark with "no vault plane mounted".
    const layout = daemonLayoutFor("./relative");
    expect(
      layout.vaultDir.endsWith(path.join("relative", "vault"))
    ).toBeTruthy();
  });

  // End-to-end: spawn the CLI via tsx, parse "listening on …" out of stdout,
  // hit /centraid/_apps with the loopback secret, assert 200, send SIGTERM,
  // confirm clean exit. Issue #505 phase 7 retired the persistent `token.bin`
  // and stopped PRINTING any bearer — the daemon mints an ephemeral per-boot
  // loopback secret instead. A parent (here the test, mirroring the desktop's
  // detached-gateway spawn) pins a known value via `CENTRAID_GATEWAY_TOKEN` so
  // it can reach the loopback listener; the secret is never written to disk.
  test("serve subcommand boots, accepts the parent-supplied loopback secret, and exits cleanly on SIGTERM", async (t) => {
    // Skip if tsx isn't installed locally — the gate is `bun install` having
    // run at the monorepo root, not on every developer's machine.
    try {
      await fs.stat(TSX_BIN);
    } catch {
      t.skip(
        `tsx not found at ${TSX_BIN} — run "bun install" at the monorepo root`
      );
      return;
    }
    const token = crypto.randomBytes(32).toString("hex");
    const child = spawn(
      TSX_BIN,
      [
        CLI_TS,
        "serve",
        "--data-dir",
        dataDir,
        "--host",
        "127.0.0.1",
        "--port",
        "0",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CENTRAID_GATEWAY_TOKEN: token },
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => {
      stdout += b.toString();
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString();
    });

    // Wait until the listening line has been printed. The bearer is NOT printed
    // (phase 7) — the parent already knows it (it supplied CENTRAID_GATEWAY_TOKEN).
    const urlLocal = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`startup timeout; stderr=${stderr}`)),
        15_000
      );
      const check = (): void => {
        const urlMatch = stdout.match(/listening on (?<url>http:\/\/[^\s]+)/u);
        if (urlMatch) {
          clearTimeout(timer);
          resolve(urlMatch.groups!.url!);
        }
      };
      child.stdout.on("data", check);
      check();
    });

    // The ephemeral secret must never leak to stdout.
    expect(stdout).not.toContain(token);
    expect(stdout).not.toMatch(/token:/u);

    try {
      const ok = await fetch(`${urlLocal}/centraid/_apps`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as unknown[];
      expect(body).toStrictEqual([]);

      const unauth = await fetch(`${urlLocal}/centraid/_apps`);
      expect(unauth.status).toBe(401);
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }

    expect(stderr).toMatch(/SIGTERM received/u);
  });
});
