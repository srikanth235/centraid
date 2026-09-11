/**
 * DAST verdicts — pure judges over probe observations (W2.4, #842 / #839 B5).
 *
 * Each function takes a recorded response shape and returns a Finding (or
 * none). The live scanner in `dast-scan.ts` feeds them; the unit suite
 * sabotages each one so a silent-pass cannot hide a broken check.
 */

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
