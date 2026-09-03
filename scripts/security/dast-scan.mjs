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

const FOREIGN_ORIGIN = "http://evil.example";
const SHELL_ORIGIN = "http://127.0.0.1:4173";

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

export async function scanTarget({
  baseUrl,
  token,
  routes,
  cookieAuth = false,
}) {
  const findings = [];
  const auth = { authorization: `Bearer ${token}` };
  const routeEntries = Object.entries(routes);

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

export function loadPinRegister(pinPath = KNOWN_FINDINGS_PATH) {
  try {
    return JSON.parse(readFileSync(pinPath, "utf8")).keys ?? {};
  } catch {
    return {};
  }
}

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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`dast: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}
