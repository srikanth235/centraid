/**
 * DAST lane — dynamic scan of the booted gateway's composed HTTP surface
 * (W2.4, umbrella #842 / #839 slice B5).
 *
 * All other security testing in this repo is STATIC: it reads source and
 * asserts shape. This lane boots the REAL gateway HTTP boundary
 * (`startRuntimeHttpServer` in front of a real `Runtime`, the same code path
 * `serve/build-gateway.ts` wraps for desktop and daemon) and probes the
 * composed surface a browser or attacker actually reaches: header posture,
 * CORS reflection, per-route method fuzzing, and the Host-header allowlist.
 *
 * Why a route-table-driven script and NOT ZAP (the slice's open question):
 * no external dependency (ZAP is a ~1.5 GB Java daemon; this boots the gateway
 * in-process with the toolchain Node); deterministic (enumerates the `ROUTES`
 * table from `@centraid/core/protocol` over a fixed verb matrix — no crawler
 * drift); authenticated and route-aware for free (the gateway hands us the
 * token and the route table); and the judges encode Centraid's decided posture
 * (SECURITY.md "Loopback / browser control-plane", #504 — bearer intent MAY be
 * reflected with credentials, foreign cookie origins MAY NOT), so a regression
 * is a specific failed assertion, not a generic alert a human must triage.
 *
 * Findings whose `pinKey` is registered in `dast-known-findings.json` are
 * reported but do not fail the lane — recorded defects awaiting a product
 * decision, exactly like the fuzz lane's `known-findings.json`. Anything else
 * fails the run.
 *
 * Usage:
 *   node scripts/security/dast-scan.ts                 # boot + scan (nightly)
 *   node scripts/security/dast-scan.ts --json          # summary JSON to stdout
 *   node scripts/security/dast-scan.ts --out artifacts/dast/summary.json
 *   node scripts/security/dast-scan.ts --target http://127.0.0.1:PORT \
 *        --token <bearer>                                # scan an external target
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const KNOWN_FINDINGS_PATH = path.join(
  root,
  "scripts/security/dast-known-findings.json"
);

/** Verb matrix probed against every route. TRACE/CONNECT are covered via raw
 *  HTTP because `undici`'s fetch refuses them — the point is to prove the
 *  gateway refuses them too, so we must be able to send them. */
export const FUZZ_METHODS = Object.freeze([
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "TRACE",
  "FROB",
  "OPTIONS",
]);

/** A foreign origin that is never a bound shell — the CORS attacker origin. */
const FOREIGN_ORIGIN = "http://evil.example";
/** A stand-in bound shell origin for the credentialed-CORS posture probe. */
const SHELL_ORIGIN = "http://127.0.0.1:4173";

// --- Judges: pure, exported, unit-tested with paired pass/sabotage cases. ---

export interface Finding {
  pinKey: string;
  category: string;
  severity: "info" | "low" | "medium" | "high";
  target: string;
  expected: string;
  actual: string;
  verdict: "pass" | "fail";
}

/**
 * A JSON response must carry `X-Content-Type-Options: nosniff`. Applies only
 * when the response advertises a JSON content type; non-JSON responses are
 * governed by the shell CSP posture, not this judge.
 * @returns {Finding|null} A finding, or null when the check does not apply.
 */
export function judgeJsonNosniff(input: {
  target: string;
  contentType?: string | null;
  nosniff?: string | null;
  boundary?: boolean;
}): Finding | null {
  const { target, contentType, nosniff, boundary } = input;
  if (!/application\/json/iu.test(contentType ?? "")) return null;
  const ok = (nosniff ?? "").toLowerCase() === "nosniff";
  return {
    pinKey: boundary
      ? "header.boundary-response-nosniff"
      : "header.handler-response-nosniff",
    category: "header",
    severity: "low",
    target,
    expected: "X-Content-Type-Options: nosniff on JSON response",
    actual: nosniff === null || nosniff === undefined ? "(absent)" : nosniff,
    verdict: ok ? "pass" : "fail",
  };
}

/**
 * Every `Set-Cookie` on a browser-reachable surface must be HttpOnly and carry
 * an explicit SameSite; over HTTPS it must also be Secure. Returns one finding
 * per violated attribute (empty array = clean).
 * @returns {Finding[]} One finding per required cookie attribute.
 */
export function judgeCookieFlags(input: {
  target: string;
  setCookie?: string | null;
  isHttps: boolean;
}): Finding[] {
  const { target, setCookie, isHttps } = input;
  const value = (setCookie ?? "").toLowerCase();
  const attrs = value.split(";").map((s: string) => s.trim());
  const has = (name: string) =>
    attrs.some((a: string) => a === name || a.startsWith(`${name}=`));
  const findings: Finding[] = [];
  const want = [
    { name: "httponly", label: "HttpOnly", need: true },
    { name: "samesite", label: "SameSite", need: true },
    { name: "secure", label: "Secure", need: Boolean(isHttps) },
  ];
  for (const { name, label, need } of want) {
    if (!need) continue;
    findings.push({
      pinKey: `cookie.${name}`,
      category: "cookie",
      severity: "medium",
      target,
      expected: `Set-Cookie carries ${label}`,
      actual: has(name) ? `${label} present` : `${label} absent`,
      verdict: has(name) ? "pass" : "fail",
    });
  }
  return findings;
}

/**
 * CORS verdict for one probed Origin. `expectCredentialed` encodes the decided
 * posture per SECURITY.md / issue #504:
 *   - Bearer intent OR a bound shell origin → reflect Origin + credentials.
 *   - Foreign cookie-only origin OR `Origin: null` → never reflect that origin
 *     WITH credentials (an attacker page must not read the body under
 *     `credentials: 'include'`); `*` without credentials is fine.
 * @returns {Finding} The verdict for this probe.
 */
export function judgeCorsVerdict(input: {
  target: string;
  origin: string;
  acao?: string | null;
  acac?: string | null;
  expectCredentialed: boolean;
}): Finding {
  const { target, origin, acao, acac, expectCredentialed } = input;
  const credentialed = (acac ?? "").toLowerCase() === "true";
  const reflected = acao === origin;
  let ok;
  let expected;
  if (expectCredentialed) {
    ok = reflected && credentialed;
    expected = `Access-Control-Allow-Origin: ${origin} + Allow-Credentials: true`;
  } else {
    // The dangerous combination is a REFLECTED attacker origin paired with
    // credentials. `*` (no creds) or a non-reflected origin is acceptable.
    ok = !(reflected && credentialed);
    expected = `never reflect ${origin} with Allow-Credentials: true`;
  }
  return {
    pinKey: expectCredentialed
      ? "cors.credentialed-denied"
      : "cors.foreign-reflected-with-credentials",
    category: "cors",
    severity: "high",
    target,
    expected,
    actual: `Allow-Origin: ${acao ?? "(absent)"}, Allow-Credentials: ${
      acac ?? "(absent)"
    }`,
    verdict: ok ? "pass" : "fail",
  };
}

/**
 * Method-fuzz verdict for one (route, method) probe.
 *   - `preflight`: an OPTIONS preflight must answer 204 before auth.
 *   - `refused`: any other verb, presented WITHOUT credentials, must be
 *     client-refused (4xx) and never a silent 2xx/3xx — the auth gate has to
 *     catch every method on every route. An unknown verb presented WITH
 *     credentials must still be refused (never a silent 2xx).
 * @returns {Finding} The verdict for this probe.
 */
export function judgeMethodVerdict(input: {
  target: string;
  method: string;
  status: number;
  expectation: string;
}): Finding {
  const { target, method, status, expectation } = input;
  let ok;
  let expected;
  if (expectation === "preflight") {
    ok = status === 204;
    expected = "OPTIONS preflight → 204";
  } else {
    ok = status >= 400 && status < 500;
    expected = `${method} → client refusal (4xx), never a silent 2xx`;
  }
  return {
    pinKey:
      expectation === "preflight"
        ? "method.preflight"
        : "method.silent-success",
    category: "method",
    severity: status >= 200 && status < 300 ? "high" : "low",
    target,
    expected,
    actual: `HTTP ${status}`,
    verdict: ok ? "pass" : "fail",
  };
}

/**
 * Host-allowlist verdict. A foreign Host must be refused with 400 invalid_host
 * BEFORE auth or handlers (DNS-rebinding posture, issue #504).
 * @returns {Finding} The verdict for this probe.
 */
export function judgeHostVerdict(input: {
  target: string;
  status: number;
  body?: string;
}): Finding {
  const { target, status, body } = input;
  let error;
  try {
    error = JSON.parse(body ?? "").error;
  } catch {
    error = undefined;
  }
  const ok = status === 400 && error === "invalid_host";
  return {
    pinKey: "host.foreign-accepted",
    category: "host",
    severity: "high",
    target,
    expected: "foreign Host → 400 invalid_host",
    actual: `HTTP ${status}${error ? ` (${error})` : ""}`,
    verdict: ok ? "pass" : "fail",
  };
}

// --- Transport: raw HTTP for arbitrary methods + a custom Host (fetch forbids
//     both); mirrors the harness in http-server.test.ts. --------------------

/**
 * @param {string} baseUrl Base URL of the target.
 * @param {string} requestPath Path to request.
 * @param {object} [opts] method / host / headers overrides.
 * @returns {Promise<{status:number, headers:http.IncomingHttpHeaders, body:string}>} The response status, headers, and body text.
 */
function headerText(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export function rawRequest(
  baseUrl: string,
  requestPath: string,
  opts: {
    method?: string;
    host?: string;
    headers?: http.OutgoingHttpHeaders;
  } = {}
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  const u = new URL(requestPath, baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: opts.method ?? "GET",
        setHost: opts.host === undefined,
        headers: {
          ...(opts.headers ?? {}),
          ...(opts.host === undefined ? {} : { host: opts.host }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });
}

// --- Probes: drive a booted target and collect findings from the judges. ----

/**
 * Probe one live target (base URL + bearer token) across every check. When
 * `cookieAuth` is true the target treats `Cookie: session=ok` as a session and
 * knows `SHELL_ORIGIN` as a bound shell — that pair exercises the cookie/PWA
 * CORS posture the bearer path cannot.
 * @returns {Promise<Finding[]>} Every finding from probing this target.
 */
export async function scanTarget({
  baseUrl,
  token,
  routes,
  cookieAuth = false,
}: {
  baseUrl: string;
  token: string;
  routes: Record<string, string>;
  cookieAuth?: boolean;
}): Promise<Finding[]> {
  const findings: Finding[] = [];
  const auth = { authorization: `Bearer ${token}` };
  const routeEntries = Object.entries(routes);

  // --- Host allowlist: a foreign Host is refused before anything else. ------
  const firstRoute = routeEntries[0]?.[1] ?? "/centraid/_apps";
  if (typeof firstRoute !== "string") {
    throw new Error("scanTarget: routes table is empty");
  }
  const foreignHost = await rawRequest(baseUrl, firstRoute, {
    host: "evil.example:9999",
    headers: auth,
  });
  findings.push(
    judgeHostVerdict({
      target: `Host: evil.example → ${firstRoute}`,
      status: foreignHost.status,
      body: foreignHost.body,
    })
  );

  // --- Header posture on a real 200 and on the 401 boundary response. -------
  const authed200 = await rawRequest(baseUrl, "/centraid/_apps", {
    headers: auth,
  });
  const nosniff200 = judgeJsonNosniff({
    target: "authed 200 /centraid/_apps",
    contentType: headerText(authed200.headers["content-type"]),
    nosniff: headerText(authed200.headers["x-content-type-options"]),
    boundary: false,
  });
  if (nosniff200) findings.push(nosniff200);

  const unauth401 = await rawRequest(baseUrl, "/centraid/_apps");
  const nosniff401 = judgeJsonNosniff({
    target: "unauth 401 boundary /centraid/_apps",
    contentType: headerText(unauth401.headers["content-type"]),
    nosniff: headerText(unauth401.headers["x-content-type-options"]),
    boundary: true,
  });
  if (nosniff401) findings.push(nosniff401);

  const invalidHostBody = judgeJsonNosniff({
    target: "invalid_host 400 boundary",
    contentType: headerText(foreignHost.headers["content-type"]),
    nosniff: headerText(foreignHost.headers["x-content-type-options"]),
    boundary: true,
  });
  if (invalidHostBody) findings.push(invalidHostBody);

  // --- Cookie flags: assert on any Set-Cookie the surface emits. The core
  //     control-plane API is token-driven and emits none (vacuously clean). ---
  const setCookie = authed200.headers["set-cookie"];
  if (Array.isArray(setCookie)) {
    for (const cookie of setCookie) {
      findings.push(
        ...judgeCookieFlags({
          target: "authed response Set-Cookie",
          setCookie: cookie,
          isHttps: baseUrl.startsWith("https:"),
        })
      );
    }
  }

  // --- CORS probes. Bearer intent + foreign origin: reflect-with-credentials
  //     is the decided posture (the token is not ambient). -------------------
  const bearerForeign = await rawRequest(baseUrl, "/centraid/_apps", {
    headers: { ...auth, origin: FOREIGN_ORIGIN },
  });
  findings.push(
    judgeCorsVerdict({
      target: `CORS bearer + Origin ${FOREIGN_ORIGIN}`,
      origin: FOREIGN_ORIGIN,
      acao: bearerForeign.headers["access-control-allow-origin"] ?? null,
      acac: bearerForeign.headers["access-control-allow-credentials"] ?? null,
      expectCredentialed: true,
    })
  );
  // `Origin: null` (desktop file:// renderer) must never get credentials.
  const nullOrigin = await rawRequest(baseUrl, "/centraid/_apps", {
    headers: { ...auth, origin: "null" },
  });
  findings.push(
    judgeCorsVerdict({
      target: "CORS Origin: null",
      origin: "null",
      acao: nullOrigin.headers["access-control-allow-origin"] ?? null,
      acac: nullOrigin.headers["access-control-allow-credentials"] ?? null,
      expectCredentialed: false,
    })
  );

  if (cookieAuth) {
    // Foreign cookie-only origin: even if the cookie authenticates, CORS must
    // not let the attacker origin read the body under credentials mode.
    const foreignCookie = await rawRequest(baseUrl, "/centraid/_apps", {
      headers: { origin: FOREIGN_ORIGIN, cookie: "session=ok" },
    });
    findings.push(
      judgeCorsVerdict({
        target: `CORS foreign cookie Origin ${FOREIGN_ORIGIN}`,
        origin: FOREIGN_ORIGIN,
        acao: foreignCookie.headers["access-control-allow-origin"] ?? null,
        acac: foreignCookie.headers["access-control-allow-credentials"] ?? null,
        expectCredentialed: false,
      })
    );
    // The bound shell origin DOES get credentialed CORS.
    const boundShell = await rawRequest(baseUrl, "/centraid/_apps", {
      headers: { origin: SHELL_ORIGIN, cookie: "session=ok" },
    });
    findings.push(
      judgeCorsVerdict({
        target: `CORS bound shell Origin ${SHELL_ORIGIN}`,
        origin: SHELL_ORIGIN,
        acao: boundShell.headers["access-control-allow-origin"] ?? null,
        acac: boundShell.headers["access-control-allow-credentials"] ?? null,
        expectCredentialed: true,
      })
    );
  }

  // --- Method fuzzing over every ROUTES entry: every verb must be caught by
  //     the auth gate — never a silent 2xx (OPTIONS is the 204 preflight
  //     exception), plus one authenticated unknown-verb probe per route. The
  //     probes are independent; fired together, judged in descriptor order. ---
  const methodProbes = routeEntries.flatMap(([name, routePath]) => [
    ...FUZZ_METHODS.map((method) => ({
      name,
      routePath,
      method,
      req: { method },
      expectation: method === "OPTIONS" ? "preflight" : "refused",
      label: `${method} ${name} (${routePath}) unauthenticated`,
    })),
    {
      name,
      routePath,
      method: "FROB",
      req: { method: "FROB", headers: auth },
      expectation: "refused",
      label: `FROB ${name} (${routePath}) authenticated`,
    },
  ]);
  const methodResults = await Promise.all(
    methodProbes.map((probe) =>
      rawRequest(baseUrl, String(probe.routePath), probe.req)
    )
  );
  methodProbes.forEach((probe, index) => {
    const result = methodResults[index];
    if (result === undefined) return;
    findings.push(
      judgeMethodVerdict({
        target: probe.label,
        method: probe.method,
        status: result.status,
        expectation: probe.expectation,
      })
    );
  });

  return findings;
}

// --- Pin register + summary. -------------------------------------------------

/** Load the pinned-findings register. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadPinRegister(
  pinPath = KNOWN_FINDINGS_PATH
): Record<string, { issue?: number; note?: string }> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(pinPath, "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.keys)) return {};
    const keys: Record<string, { issue?: number; note?: string }> = {};
    for (const [name, raw] of Object.entries(parsed.keys)) {
      if (!isRecord(raw)) continue;
      keys[name] = {
        issue: typeof raw.issue === "number" ? raw.issue : undefined,
        note: typeof raw.note === "string" ? raw.note : undefined,
      };
    }
    return keys;
  } catch {
    return {};
  }
}

/**
 * Fold findings into a summary: a failed finding whose `pinKey` is registered
 * becomes `pinned` (non-fatal); any other failure makes the lane red.
 */
export function summarize(
  findings: Array<Pick<Finding, "pinKey" | "verdict"> & Partial<Finding>>,
  pinRegister: Record<string, { issue?: number; note?: string }>
) {
  const failed: Array<Pick<Finding, "pinKey" | "verdict"> & Partial<Finding>> =
    [];
  const pinned: Array<
    Pick<Finding, "pinKey" | "verdict"> &
      Partial<Finding> & { pin: { issue?: number; note?: string } }
  > = [];
  const passed: Array<Pick<Finding, "pinKey" | "verdict"> & Partial<Finding>> =
    [];
  for (const f of findings) {
    if (f.verdict === "pass") {
      passed.push(f);
    } else {
      const pin = pinRegister[f.pinKey];
      if (pin) pinned.push({ ...f, pin });
      else failed.push(f);
    }
  }
  return {
    lane: "dast",
    totals: {
      checks: findings.length,
      passed: passed.length,
      pinned: pinned.length,
      failed: failed.length,
    },
    failed,
    pinned,
    passed,
    green: failed.length === 0,
  };
}

// --- Boot: the REAL gateway HTTP boundary, in-process, from built server. ----

/**
 * Boot two gateways off one Runtime each and scan both: a bearer-only gateway
 * (the desktop/daemon control plane) and a cookie-session gateway (the PWA
 * posture, with a bound shell origin). Returns findings from both.
 */
export async function bootAndScan() {
  const engine = (await import(
    path.join(root, "packages/server/dist/engine/index.js")
  )) as {
    Runtime: new (opts: { appsDir: string }) => {
      bootstrap: () => Promise<void>;
    };
    startRuntimeHttpServer: (opts: Record<string, unknown>) => Promise<{
      url: string;
      token: string;
      close: () => Promise<void>;
    }>;
  };
  const protocol = (await import(
    path.join(root, "packages/core/dist/protocol/index.js")
  )) as { ROUTES: Record<string, string> };
  const { Runtime, startRuntimeHttpServer } = engine;
  const { ROUTES } = protocol;

  const workspaces: string[] = [];
  const servers: Array<{ close: () => Promise<void> }> = [];
  const boot = async (options: Record<string, unknown>) => {
    const ws = mkdtempSync(path.join(tmpdir(), "dast-"));
    workspaces.push(ws);
    const runtime = new Runtime({ appsDir: ws });
    const server = await startRuntimeHttpServer({ runtime, ...options });
    await runtime.bootstrap();
    servers.push(server);
    return server;
  };

  try {
    const bearerServer = await boot({});
    const cookieServer = await boot({
      credentialedCorsOrigins: [SHELL_ORIGIN],
      authorizeRequest: (req: { headers: { cookie?: string } }) =>
        (req.headers.cookie ?? "").includes("session=ok")
          ? { plane: "admin" }
          : undefined,
    });

    const findings = [
      ...(await scanTarget({
        baseUrl: bearerServer.url,
        token: bearerServer.token,
        routes: ROUTES,
      })),
      ...(await scanTarget({
        baseUrl: cookieServer.url,
        token: cookieServer.token,
        routes: ROUTES,
        cookieAuth: true,
      })),
    ];
    return findings;
  } finally {
    await Promise.all(
      servers.map((server) => server.close().catch(() => undefined))
    );
    for (const ws of workspaces) rmSync(ws, { recursive: true, force: true });
  }
}

// --- CLI. --------------------------------------------------------------------

function parseArgs(argv: string[]): {
  json: boolean;
  target?: string;
  token?: string;
  out?: string;
} {
  const out: { json: boolean; target?: string; token?: string; out?: string } =
    { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--json") out.json = true;
    else if (token === "--target") out.target = argv[(i += 1)];
    else if (token === "--token") out.token = argv[(i += 1)];
    else if (token === "--out") out.out = argv[(i += 1)];
    else throw new Error(`unknown flag \`${token}\``);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pinRegister = loadPinRegister();

  let findings;
  if (args.target) {
    if (!args.token) throw new Error("--target requires --token");
    const protocol = (await import(
      path.join(root, "packages/core/dist/protocol/index.js")
    )) as { ROUTES: Record<string, string> };
    const { ROUTES } = protocol;
    findings = await scanTarget({
      baseUrl: args.target,
      token: args.token,
      routes: ROUTES,
    });
  } else {
    findings = await bootAndScan();
  }

  const summary = summarize(findings, pinRegister);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    console.log(
      `dast: ${summary.totals.checks} checks — ${summary.totals.passed} passed, ` +
        `${summary.totals.pinned} pinned, ${summary.totals.failed} failed`
    );
    for (const f of summary.pinned) {
      const issue = f.pin?.issue;
      const ref = issue ? `#${issue}` : "UNFILED — file a bug and set issue";
      console.log(
        `  PINNED  [${f.category}] ${f.target}\n            expected: ${f.expected}\n            actual:   ${f.actual}\n            bug: ${ref}`
      );
    }
    for (const f of summary.failed) {
      console.log(
        `  FAIL    [${f.category}/${f.severity}] ${f.target}\n            expected: ${f.expected}\n            actual:   ${f.actual}`
      );
    }
  }

  const outPath = args.out ?? path.join(root, "artifacts/dast/summary.json");
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`);

  process.exitCode = summary.green ? 0 : 1;
}

// Only run when invoked directly, never when imported by the test file.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`dast: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}
