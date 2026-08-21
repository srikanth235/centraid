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
 *   node scripts/security/dast-scan.mjs                 # boot + scan (nightly)
 *   node scripts/security/dast-scan.mjs --json          # summary JSON to stdout
 *   node scripts/security/dast-scan.mjs --out artifacts/dast/summary.json
 *   node scripts/security/dast-scan.mjs --target http://127.0.0.1:PORT \
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

// ---------------------------------------------------------------------------
// Judges — pure, exported, unit-tested with paired pass/sabotage cases.
// Each returns a finding object (or null when the check does not apply).
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Finding
 * @property {string} pinKey Stable key; a match in the pin register downgrades a fail to "pinned".
 * @property {string} category One of header | cors | method | host | cookie.
 * @property {"info"|"low"|"medium"|"high"} severity Impact if the fail is real.
 * @property {string} target Human-readable subject (route + probe).
 * @property {string} expected The posture this probe asserts.
 * @property {string} actual What the gateway actually returned.
 * @property {"pass"|"fail"} verdict Whether the probe met the expectation.
 */

/**
 * A JSON response must carry `X-Content-Type-Options: nosniff`. Applies only
 * when the response advertises a JSON content type; non-JSON responses are
 * governed by the shell CSP posture, not this judge.
 * @returns {Finding|null} A finding, or null when the check does not apply.
 */
export function judgeJsonNosniff({ target, contentType, nosniff, boundary }) {
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
export function judgeCookieFlags({ target, setCookie, isHttps }) {
  const value = (setCookie ?? "").toLowerCase();
  const attrs = value.split(";").map((s) => s.trim());
  const has = (name) =>
    attrs.some((a) => a === name || a.startsWith(`${name}=`));
  const findings = [];
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
export function judgeCorsVerdict({
  target,
  origin,
  acao,
  acac,
  expectCredentialed,
}) {
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
export function judgeMethodVerdict({ target, method, status, expectation }) {
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
export function judgeHostVerdict({ target, status, body }) {
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

// ---------------------------------------------------------------------------
// Transport — raw HTTP so we can send arbitrary methods and a custom Host
// (undici's fetch forbids both). Mirrors the harness in http-server.test.ts.
// ---------------------------------------------------------------------------

/**
 * @param {string} baseUrl Base URL of the target.
 * @param {string} requestPath Path to request.
 * @param {object} [opts] method / host / headers overrides.
 * @returns {Promise<{status:number, headers:http.IncomingHttpHeaders, body:string}>} The response status, headers, and body text.
 */
export function rawRequest(baseUrl, requestPath, opts = {}) {
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
          ...opts.headers,
          ...(opts.host === undefined ? {} : { host: opts.host }),
        },
      },
      (res) => {
        const chunks = [];
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

// ---------------------------------------------------------------------------
// Probes — drive a booted target and collect findings from the judges.
// ---------------------------------------------------------------------------

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
}) {
  const findings = [];
  const auth = { authorization: `Bearer ${token}` };
  const routeEntries = Object.entries(routes);

  // --- Host allowlist: a foreign Host is refused before anything else. ------
  const firstRoute = routeEntries[0]?.[1] ?? "/centraid/_apps";
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
    contentType: authed200.headers["content-type"],
    nosniff: authed200.headers["x-content-type-options"] ?? null,
    boundary: false,
  });
  if (nosniff200) findings.push(nosniff200);

  const unauth401 = await rawRequest(baseUrl, "/centraid/_apps");
  const nosniff401 = judgeJsonNosniff({
    target: "unauth 401 boundary /centraid/_apps",
    contentType: unauth401.headers["content-type"],
    nosniff: unauth401.headers["x-content-type-options"] ?? null,
    boundary: true,
  });
  if (nosniff401) findings.push(nosniff401);

  const invalidHostBody = judgeJsonNosniff({
    target: "invalid_host 400 boundary",
    contentType: foreignHost.headers["content-type"],
    nosniff: foreignHost.headers["x-content-type-options"] ?? null,
    boundary: true,
  });
  if (invalidHostBody) findings.push(invalidHostBody);

  // --- Cookie flags: assert on any Set-Cookie the surface emits. The core
  //     control-plane API is bearer/token driven and emits none, so this is
  //     vacuously clean here; the judge is exercised by the unit tests and
  //     stays wired for any surface that starts setting cookies. -------------
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

  // --- CORS probes. ----------------------------------------------------------
  // Bearer intent + foreign origin: reflect-with-credentials is the decided
  // posture (the token is not ambient).
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

  // --- Method fuzzing over every ROUTES entry. Every verb on every route must
  //     be caught by the auth gate — never a silent 2xx. OPTIONS is the
  //     preflight exception (answered 204 before auth). Each route also gets
  //     one AUTHENTICATED unknown-verb probe: an undeclared verb must not
  //     succeed silently even for the token holder. The probes are independent,
  //     so they are built as a flat descriptor list and fired together; the
  //     judged findings keep the descriptor order, so the summary is stable. --
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
    methodProbes.map((probe) => rawRequest(baseUrl, probe.routePath, probe.req))
  );
  methodProbes.forEach((probe, index) => {
    findings.push(
      judgeMethodVerdict({
        target: probe.label,
        method: probe.method,
        status: methodResults[index].status,
        expectation: probe.expectation,
      })
    );
  });

  return findings;
}

// ---------------------------------------------------------------------------
// Pin register + summary.
// ---------------------------------------------------------------------------

/** Load the pinned-findings register. */
export function loadPinRegister(pinPath = KNOWN_FINDINGS_PATH) {
  try {
    return JSON.parse(readFileSync(pinPath, "utf8")).keys ?? {};
  } catch {
    return {};
  }
}

/**
 * Fold findings into a summary. A failed finding whose `pinKey` is registered
 * becomes `pinned` (reported, non-fatal); an unregistered failure is `failed`
 * and makes the lane red.
 */
export function summarize(findings, pinRegister) {
  const failed = [];
  const pinned = [];
  const passed = [];
  for (const f of findings) {
    if (f.verdict === "pass") {
      passed.push(f);
    } else if (pinRegister[f.pinKey]) {
      pinned.push({ ...f, pin: pinRegister[f.pinKey] });
    } else {
      failed.push(f);
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

// ---------------------------------------------------------------------------
// Boot — the REAL gateway HTTP boundary, in-process, from the built server.
// ---------------------------------------------------------------------------

/**
 * Boot two gateways off one Runtime each and scan both: a bearer-only gateway
 * (the desktop/daemon control plane) and a cookie-session gateway (the PWA
 * posture, with a bound shell origin). Returns findings from both.
 */
export async function bootAndScan() {
  const { Runtime, startRuntimeHttpServer } = await import(
    path.join(root, "packages/server/dist/engine/index.js")
  );
  const { ROUTES } = await import(
    path.join(root, "packages/core/dist/protocol/index.js")
  );

  const workspaces = [];
  const servers = [];
  const boot = async (options) => {
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
      authorizeRequest: (req) =>
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

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { json: false };
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
    const { ROUTES } = await import(
      path.join(root, "packages/core/dist/protocol/index.js")
    );
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
