import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs, createWriteStream } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

import { daemonKeyStore } from "../../../packages/server/dist/cli/key-store.js";
import { landlordBearerForEndpointSecret } from "../../../packages/server/dist/cli/landlord-auth.js";
import { daemonLayoutFor } from "../../../packages/server/dist/cli/paths.js";
import {
  createTunnelClient,
  tunnelRequest,
} from "../../../packages/tunnel/dist/index.js";
import {
  defaultRunId,
  writeFlowVerdict,
} from "../../agent-e2e-shared/harness.mjs";

const __dirname = import.meta.dirname;
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const GATEWAY_CLI = path.join(
  REPO_ROOT,
  "packages",
  "server",
  "dist",
  "cli",
  "cli.js"
);
const TUNNEL_DIST = path.join(
  REPO_ROOT,
  "packages",
  "tunnel",
  "dist",
  "index.js"
);
const RUNS_DIR = path.join(__dirname, "..", "runs");

export async function ensureBuilt() {
  const checked = await Promise.all(
    [GATEWAY_CLI, TUNNEL_DIST].map(async (file) => {
      try {
        await fs.access(file);
        return undefined;
      } catch {
        return path.relative(REPO_ROOT, file);
      }
    })
  );
  const missing = checked.filter(Boolean);
  if (missing.length === 0) return;
  console.log(
    `[harness] missing ${missing.join(", ")} — running scoped build…`
  );
  await new Promise((resolve, reject) => {
    const proc = spawn(
      "bunx",
      [
        "turbo",
        "run",
        "build",
        "--filter=@centraid/server",
        "--filter=@centraid/tunnel",
      ],
      { cwd: REPO_ROOT, stdio: "inherit" }
    );
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`build exited ${code}`));
    });
  });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killAndWait(pid, { timeoutMs = 8000 } = {}) {
  if (!pid || !pidAlive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Intentionally empty.
  }
  const start = Date.now();
  const waitForExit = async () => {
    if (!pidAlive(pid)) return;
    if (Date.now() - start >= timeoutMs) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Intentionally empty.
      }
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    return waitForExit();
  };
  return waitForExit();
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("failed to reserve a loopback port");
  }
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  return address.port;
}

async function spawnDaemon(
  dataDir,
  logFile,
  { timeoutMs = 60000, port, controlSecret } = {}
) {
  const log = createWriteStream(logFile, { flags: "a" });
  const args = [
    GATEWAY_CLI,
    "serve",
    "--data-dir",
    dataDir,
    "--port",
    String(port),
  ];
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      CENTRAID_DATA_PLANE_SECRET: controlSecret,
      CENTRAID_EXPERIMENTAL: "automations,connectors",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buffer = "";
  const wanted = { url: undefined, token: undefined, endpointId: undefined };
  const scan = (chunk) => {
    log.write(chunk);
    buffer += chunk.toString("utf8");
    wanted.url ??= buffer.match(
      /listening on (?<url>http:\/\/[^\s]+)/u
    )?.groups?.url;
    wanted.endpointId ??= buffer.match(
      /endpoint: (?<endpointId>[0-9a-f]{64})/u
    )?.groups?.endpointId;
  };
  child.stdout.on("data", scan);
  child.stderr.on("data", scan);

  const start = Date.now();
  const waitForReadiness = async () => {
    if (child.exitCode !== null) {
      throw new Error(
        `daemon exited ${child.exitCode} before ready — see ${logFile}`
      );
    }
    if (wanted.url && wanted.endpointId && !wanted.token) {
      const endpointSecret = daemonKeyStore(
        daemonLayoutFor(dataDir).keysDir
      ).load("endpoint-key.bin");
      if (endpointSecret)
        wanted.token = landlordBearerForEndpointSecret(endpointSecret);
    }
    if (wanted.url && wanted.token && wanted.endpointId) {
      const response = await fetch(`${wanted.url}/centraid/_gateway/info`, {
        headers: { authorization: `Bearer ${wanted.token}` },
      });
      if (!response.ok) {
        throw new Error(
          `gateway info returned ${response.status} before ready`
        );
      }
      const info = await response.json();
      if (
        typeof info.endpointTicket !== "string" ||
        info.endpointTicket.length === 0
      ) {
        throw new Error("gateway info did not publish an endpoint ticket");
      }
      return { pid: child.pid, ...wanted, endpointTicket: info.endpointTicket };
    }
    if (Date.now() - start >= timeoutMs) {
      await killAndWait(child.pid);
      throw new Error(
        `daemon not ready in ${timeoutMs}ms (url=${wanted.url} endpoint=${wanted.endpointId}) — see ${logFile}`
      );
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
    return waitForReadiness();
  };
  return waitForReadiness();
}

function cli(dataDir, args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [GATEWAY_CLI, ...args, "--data-dir", dataDir],
      {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 || allowFailure) resolve({ code, stdout, stderr });
      else
        reject(
          new Error(
            `centraid-gateway ${args.join(" ")} exited ${code}: ${stderr.trim()}`
          )
        );
    });
  });
}

export function parseTicket(raw) {
  const payload = JSON.parse(
    Buffer.from(raw.trim(), "base64url").toString("utf8")
  );
  if (payload.v !== 1 || payload.kind !== "centraid-gw-pair") {
    throw new Error(`not a centraid-gw-pair ticket: ${raw.slice(0, 40)}…`);
  }
  return payload;
}

export async function runFlow(slug, fn, { fresh: _fresh = false } = {}) {
  await ensureBuilt();
  const runId = `${slug}-${defaultRunId()}`;
  const runDir = path.join(RUNS_DIR, runId);
  const workspace = path.join(runDir, "workspace");
  const dataDir = path.join(workspace, "gateway");
  const logFile = path.join(runDir, "gateway.log");
  await fs.mkdir(dataDir, { recursive: true });
  const previousCredentialRoot = process.env.CENTRAID_KEYSTORE_CREDENTIAL_ROOT;
  process.env.CENTRAID_KEYSTORE_CREDENTIAL_ROOT = path.join(
    workspace,
    "host-credentials"
  );

  const state = {
    runId,
    runDir,
    workspace,
    dataDir,
    port: await reserveLoopbackPort(),
    controlSecret: randomBytes(32).toString("hex"),
    gateway: undefined,
  };
  console.log(`[runFlow] ${slug}`);
  console.log(`  run dir : ${path.relative(REPO_ROOT, runDir)}`);

  const devices = [];
  const notes = [];
  let error, result;
  const t0 = Date.now();
  try {
    state.gateway = await spawnDaemon(dataDir, logFile, {
      port: state.port,
      controlSecret: state.controlSecret,
    });
    console.log(
      `  gateway : ${state.gateway.url} endpoint=${state.gateway.endpointId.slice(0, 10)}…`
    );

    const ctx = {
      state,
      dataDir,
      get gateway() {
        return state.gateway;
      },
      cli: (args, opts) =>
        cli(
          dataDir,
          args[0] === "pair" ? [...args, "--port", String(state.port)] : args,
          opts
        ),
      mintTicket: async ({ vault, ttlMinutes } = {}) => {
        const args = ["pair"];
        if (vault) args.push("--vault", vault);
        if (ttlMinutes !== undefined)
          args.push("--ttl-minutes", String(ttlMinutes));
        args.push("--port", String(state.port));
        const { stdout } = await cli(dataDir, args);
        const raw = stdout.match(/^(?<ticket>ey[A-Za-z0-9_-]{40,})$/mu)?.groups
          ?.ticket;
        if (!raw) throw new Error(`pair printed no ticket token:\n${stdout}`);
        return { raw, payload: parseTicket(raw) };
      },
      newDevice: async () => {
        const device = await createTunnelClient({ relays: "disabled" });
        devices.push(device);
        return device;
      },
      request: async (device, target) => {
        const connection = await device.connect(ctx._gwTicket());
        try {
          return await tunnelRequest(connection, { method: "GET", target });
        } finally {
          connection.close(0n, []);
        }
      },
      requestJson: async (device, method, target, body) => {
        const connection = await device.connect(ctx._gwTicket());
        try {
          const response = await tunnelRequest(connection, {
            method,
            target,
            headers: body ? { "content-type": "application/json" } : undefined,
            body: body ? Buffer.from(JSON.stringify(body)) : undefined,
          });
          return {
            response,
            json: response.body.length
              ? JSON.parse(Buffer.from(response.body).toString("utf8"))
              : undefined,
          };
        } finally {
          connection.close(0n, []);
        }
      },
      _gwTicket: () => state.gateway.endpointTicket,
      authorizeProbe: async (endpointId) => {
        const response = await fetch(
          `${state.gateway.url}/centraid/_gateway/tunnel/authorize?endpointId=${encodeURIComponent(endpointId)}`,
          {
            headers: {
              authorization: `Bearer ${state.gateway.token}`,
              "x-centraid-data-plane-secret": state.controlSecret,
            },
          }
        );
        return { response, json: await response.json() };
      },
      expectTunnelRefused: async (device) => {
        const connection = await device.connect(ctx._gwTicket());
        try {
          try {
            await tunnelRequest(connection, {
              method: "GET",
              target: "/centraid/_vault/vaults",
            });
            await connection.closed();
            await tunnelRequest(connection, {
              method: "GET",
              target: "/centraid/_vault/vaults",
            });
          } catch {
            return; // refused — expected
          }
          throw new Error(
            `device ${device.endpointId.slice(0, 10)}… was NOT refused`
          );
        } finally {
          try {
            connection.close(0n, []);
          } catch {
            // Intentionally empty.
          }
        }
      },
      restartGateway: async () => {
        console.log("  restart gateway …");
        await killAndWait(state.gateway.pid);
        state.gateway = undefined; // a failed respawn must not leave the killed daemon looking live
        state.gateway = await spawnDaemon(dataDir, logFile, {
          port: state.port,
          controlSecret: state.controlSecret,
        });
      },
      note: (m) => {
        notes.push(m);
        console.log(`  note    : ${m}`);
      },
    };

    result = await fn(ctx);
  } catch (caughtError) {
    error = caughtError;
  } finally {
    await Promise.all(
      devices.map(async (device) => device.close().catch(() => {}))
    );
    await killAndWait(state.gateway?.pid);
    if (previousCredentialRoot === undefined) {
      delete process.env.CENTRAID_KEYSTORE_CREDENTIAL_ROOT;
    } else {
      process.env.CENTRAID_KEYSTORE_CREDENTIAL_ROOT = previousCredentialRoot;
    }
  }
  const elapsedMs = Date.now() - t0;
  const pass = !error && result?.pass !== false;

  await writeFlowVerdict({
    repoRoot: REPO_ROOT,
    slug,
    runDir,
    elapsedMs,
    error,
    notes,
    result,
    metadata: {
      "gateway data dir": state.dataDir,
      "gateway endpoint": state.gateway?.endpointId ?? "never became ready",
    },
    owner: `tests/agent-e2e-pairing/flows/${slug}.mjs`,
  });

  if (pass) await fs.rm(workspace, { recursive: true, force: true });

  if (!pass) {
    if (error) console.error(error);
    process.exit(1);
  }
}
