import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * Product-CLI contract laws (#656 Layer 3 mutation seed).
 *
 * `cli.branches.test.ts` covers the failure exits. What nothing covered was
 * the half an operator actually uses: the success paths, `--json`, flag
 * consumption, and whether the usage banner still tells the truth. Those are
 * the CLI's public contract — a help text that lists a verb `main` rejects, or
 * a `--json` mode that emits something `jq` cannot read, is a bug no exit-code
 * test can see.
 *
 * Laws, not literals: each test derives its expectation from the banner or
 * from the stubbed gateway response rather than restating the implementation.
 */
import {
  GATEWAY_MIN_PROTOCOL_VERSION,
  GATEWAY_PROTOCOL_VERSION,
} from "@centraid/core/protocol";

import { resolveToken } from "./auth.ts";
import { main } from "./cli.ts";

interface CliRun {
  stdout: string;
  stderr: string;
  code: number | undefined;
}

async function runCli(
  argv: string[],
  env: Record<string, string | undefined> = {}
): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const writeOut = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
    out.push(String(c));
    return true;
  });
  const writeErr = vi.spyOn(process.stderr, "write").mockImplementation((c) => {
    err.push(String(c));
    return true;
  });
  let code: number | undefined;
  const exit = vi.spyOn(process, "exit").mockImplementation(((c?: number) => {
    code = c ?? 0;
    throw new Error(`__exit_${code}`);
  }) as never);

  const prev: Record<string, string | undefined> = {};
  for (const key of ["CENTRAID_TOKEN", "CENTRAID_GATEWAY_TOKEN"]) {
    prev[key] = process.env[key];
    const next = env[key];
    if (next === undefined) delete process.env[key];
    else process.env[key] = next;
  }

  try {
    await main(argv);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("__exit_"))
      throw error;
  } finally {
    writeOut.mockRestore();
    writeErr.mockRestore();
    exit.mockRestore();
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return { stdout: out.join(""), stderr: err.join(""), code };
}

// The protocol pair is stated against the constants for the same reason the
// rest of this file derives from the banner: a literal floor here stops
// describing a healthy gateway the moment the floor moves.
const INFO = {
  version: "0.1.0",
  protocolVersion: GATEWAY_PROTOCOL_VERSION,
  minSupportedProtocol: GATEWAY_MIN_PROTOCOL_VERSION,
  instanceId: "inst-9",
  capabilities: {
    webSessions: true,
    devicePairing: true,
    tunnel: true,
    backupWal: true,
    assistOAuth: false,
    automationTurns: true,
    multiVaultReplica: true,
    crossVaultPlacements: true,
  },
};

function jsonResponse(status: number, body: unknown): Response {
  const text = body === undefined ? "" : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => text,
  } as Response;
}

/** Stub every gateway route; `overrides` keys are matched as URL substrings. */
function stubGateway(
  overrides: Array<[match: string, status: number, body: unknown]> = []
): ReturnType<typeof vi.fn> {
  const seen: Array<{ url: string; auth: string | undefined }> = [];
  const impl = vi.fn<(input: unknown, init?: RequestInit) => Promise<Response>>(
    async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ url, auth: headers.Authorization });
      for (const [match, status, body] of overrides) {
        if (url.includes(match)) return jsonResponse(status, body);
      }
      return jsonResponse(200, INFO);
    }
  );
  Object.assign(impl, { seen });
  vi.stubGlobal("fetch", impl);
  return impl as ReturnType<typeof vi.fn>;
}

/** The usage banner, captured from the CLI itself. */
async function usageText(): Promise<string> {
  return (await runCli(["--help"])).stderr;
}

/**
 * Run several CLI invocations IN ORDER. `runCli` installs process-level spies
 * on stdout/stderr/exit, so these cannot overlap; the reduce chain is the
 * named sequential primitive (`no-await-in-loop` is on for a reason).
 */
async function runCliSequence(cases: string[][]): Promise<CliRun[]> {
  return cases.reduce<Promise<CliRun[]>>(
    async (acc, argv) => [...(await acc), await runCli(argv)],
    Promise.resolve([])
  );
}

describe("cli usage banner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("every verb the banner advertises is a verb main accepts", async () => {
    const banner = await usageText();
    const verbs = [...banner.matchAll(/^ {2}centraid (?<verb>[a-z]+)/gmu)].map(
      (m) => m.groups?.verb as string
    );
    expect(verbs.length).toBeGreaterThan(0);
    stubGateway();
    const runs = await runCliSequence(
      verbs.map((verb) => [verb, "--url", "http://gw", "--token", "t"])
    );
    for (const [index, run] of runs.entries()) {
      expect(run.stderr, verbs[index]).not.toMatch(/unknown command/u);
    }
  });

  test("every verb main accepts is advertised by the banner", async () => {
    const banner = await usageText();
    // Discovered by probing: a verb that does not error as unknown is real.
    const verbs = ["status", "health", "info", "list"];
    stubGateway();
    const runs = await runCliSequence(
      verbs.map((verb) => [verb, "--url", "http://gw", "--token", "t"])
    );
    for (const [index, run] of runs.entries()) {
      expect(run.stderr, verbs[index]).not.toMatch(/unknown command/u);
      expect(banner, verbs[index]).toContain(`centraid ${verbs[index]}`);
    }
  });

  test("the banner's auth precedence matches resolveToken's real precedence", async () => {
    const banner = await usageText();
    const listed = [
      ...banner.matchAll(/(?<name>--token|CENTRAID_[A-Z_]+)/gu),
    ].map((m) => m.groups?.name as string);
    const order = [...new Set(listed)].filter(
      (n) => n === "--token" || n.startsWith("CENTRAID_")
    );
    expect(order).toStrictEqual([
      "--token",
      "CENTRAID_TOKEN",
      "CENTRAID_GATEWAY_TOKEN",
    ]);
    // …and the resolver honours exactly that order.
    const env = { CENTRAID_TOKEN: "b", CENTRAID_GATEWAY_TOKEN: "c" };
    expect(resolveToken({ token: "a", env })).toBe("a");
    expect(resolveToken({ env })).toBe("b");
    expect(resolveToken({ env: { CENTRAID_GATEWAY_TOKEN: "c" } })).toBe("c");
  });

  test("the banner names the tool and the required --url flag", async () => {
    const banner = await usageText();
    expect(banner).toMatch(/^Usage:/u);
    expect(banner).toContain("--url");
    expect(banner).toContain("--help");
    expect(banner).toContain("--version");
    // A blank line separates the verb table from the auth note.
    expect(banner).toContain("\n\n");
  });
});

describe("cli output shape", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("--json emits exactly one parseable line; the default emits indented JSON", async () => {
    stubGateway();
    const compact = await runCli([
      "status",
      "--url",
      "http://gw",
      "--token",
      "t",
      "--json",
    ]);
    expect(compact.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(compact.stdout.endsWith("\n")).toBe(true);

    stubGateway();
    const pretty = await runCli([
      "status",
      "--url",
      "http://gw",
      "--token",
      "t",
    ]);
    expect(pretty.stdout.trimEnd().split("\n").length).toBeGreaterThan(1);
    expect(pretty.stdout).toContain("\n  ");

    // Same data either way — `--json` changes the formatting, not the payload.
    expect(JSON.parse(compact.stdout)).toStrictEqual(JSON.parse(pretty.stdout));
  });

  test("status reports the handshake fields the gateway returned", async () => {
    stubGateway();
    const run = await runCli([
      "status",
      "--url",
      "http://gw",
      "--token",
      "t",
      "--json",
    ]);
    expect(run.code).toBeUndefined();
    const printed = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(printed.capabilities).toStrictEqual(INFO.capabilities);
    const { capabilities, ...rest } = printed;
    expect(capabilities).toBeTypeOf("object");
    expect(rest).toStrictEqual({
      ok: true,
      version: INFO.version,
      protocolVersion: INFO.protocolVersion,
      minSupportedProtocol: INFO.minSupportedProtocol,
      instanceId: INFO.instanceId,
    });
    // Every advertised field is present — a dropped key is not "extra".
    expect(Object.keys(printed).sort()).toStrictEqual([
      "capabilities",
      "instanceId",
      "minSupportedProtocol",
      "ok",
      "protocolVersion",
      "version",
    ]);
  });

  test("`info` is an alias for `status`, not a second route", async () => {
    stubGateway();
    const status = await runCli([
      "status",
      "--url",
      "http://gw",
      "--token",
      "t",
      "--json",
    ]);
    stubGateway();
    const info = await runCli([
      "info",
      "--url",
      "http://gw",
      "--token",
      "t",
      "--json",
    ]);
    expect(info.stdout).toBe(status.stdout);
  });

  test("health prints the gateway body verbatim, or a synthesised ok", async () => {
    stubGateway([["/health", 200, { ok: true, status: "healthy", uptime: 5 }]]);
    const withBody = await runCli([
      "health",
      "--url",
      "http://gw",
      "--token",
      "t",
      "--json",
    ]);
    expect(JSON.parse(withBody.stdout)).toStrictEqual({
      ok: true,
      status: "healthy",
      uptime: 5,
    });

    // An empty 200 body must still print a truthful ok object, not "null".
    stubGateway([["/health", 200, undefined]]);
    const empty = await runCli([
      "health",
      "--url",
      "http://gw",
      "--token",
      "t",
      "--json",
    ]);
    expect(JSON.parse(empty.stdout)).toStrictEqual({ ok: true, status: 200 });
  });

  test("list prints the gateway's array unchanged", async () => {
    stubGateway([["/_apps", 200, [{ id: "alpha" }, { id: "beta" }]]]);
    const run = await runCli([
      "list",
      "--url",
      "http://gw",
      "--token",
      "t",
      "--json",
    ]);
    expect(JSON.parse(run.stdout)).toStrictEqual([
      { id: "alpha" },
      { id: "beta" },
    ]);
  });
});

describe("cli http status boundaries", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test.each([
    ["health", "/health", 199, 1],
    ["health", "/health", 200, undefined],
    ["health", "/health", 299, undefined],
    ["health", "/health", 300, 1],
    ["list", "/_apps", 199, 1],
    ["list", "/_apps", 200, undefined],
    ["list", "/_apps", 299, undefined],
    ["list", "/_apps", 300, 1],
  ])(
    "%s treats HTTP %s (status %d) as exit %s",
    async (verb, route, status, expected) => {
      stubGateway([[route, status as number, { ok: true }]]);
      const run = await runCli([
        verb as string,
        "--url",
        "http://gw",
        "--token",
        "t",
        "--json",
      ]);
      expect(run.code).toBe(expected);
    }
  );

  test("a 401 on list is reported as unauthorized, not a bare HTTP code", async () => {
    stubGateway([["/_apps", 401, { error: "nope" }]]);
    const run = await runCli(["list", "--url", "http://gw", "--token", "t"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/unauthorized/u);
    expect(run.stderr).toMatch(/CENTRAID_TOKEN/u);
  });
});

describe("cli argument parsing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("--url and --token consume the following argument, not the flag itself", async () => {
    const fetchImpl = stubGateway();
    await runCli([
      "status",
      "--url",
      "http://example.test",
      "--token",
      "sekret",
    ]);
    const seen = (fetchImpl as unknown as { seen: Array<{ url: string }> })
      .seen;
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]?.url.startsWith("http://example.test")).toBe(true);
    // The value must not have been treated as the command.
    expect(seen[0]?.url).not.toContain("--token");
  });

  test("the bearer comes from --token, and falls back to the environment", async () => {
    const explicit = stubGateway();
    await runCli(["list", "--url", "http://gw", "--token", "flag-token"]);
    const explicitSeen = (
      explicit as unknown as { seen: Array<{ auth?: string }> }
    ).seen;
    expect(explicitSeen.some((r) => r.auth === "Bearer flag-token")).toBe(true);

    const fromEnv = stubGateway();
    await runCli(["list", "--url", "http://gw"], {
      CENTRAID_TOKEN: "env-token",
    });
    const envSeen = (fromEnv as unknown as { seen: Array<{ auth?: string }> })
      .seen;
    expect(envSeen.some((r) => r.auth === "Bearer env-token")).toBe(true);
  });

  test("flag order does not matter and the first non-flag argument is the command", async () => {
    stubGateway();
    const before = await runCli([
      "--json",
      "--url",
      "http://gw",
      "--token",
      "t",
      "status",
    ]);
    stubGateway();
    const after = await runCli([
      "status",
      "--url",
      "http://gw",
      "--token",
      "t",
      "--json",
    ]);
    expect(before.stdout).toBe(after.stdout);
    expect(before.code).toBeUndefined();
  });

  test("-h and -V are accepted as short forms with the same exits", async () => {
    const long = await runCli(["--help"]);
    const short = await runCli(["-h"]);
    expect(short.code).toBe(long.code);
    expect(short.stderr).toBe(long.stderr);

    const version = await runCli(["--version"]);
    const shortVersion = await runCli(["-V"]);
    expect(shortVersion.code).toBe(0);
    expect(shortVersion.stdout).toBe(version.stdout);
    expect(shortVersion.stdout.trimEnd().split("\n")).toHaveLength(1);
  });

  test("the explicit `help` verb prints the same banner as --help", async () => {
    const flag = await runCli(["--help"]);
    const verb = await runCli(["help", "--url", "http://gw"]);
    expect(verb.stderr).toBe(flag.stderr);
    expect(verb.code).toBe(2);
  });

  test("errors are prefixed with the tool name on stderr, never stdout", async () => {
    const run = await runCli(["nope", "--url", "http://gw"]);
    expect(run.stderr.startsWith("centraid: ")).toBe(true);
    expect(run.stderr.endsWith("\n")).toBe(true);
    expect(run.stdout).toBe("");
  });
});
