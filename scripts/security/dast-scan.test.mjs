/**
 * Unit tests for the DAST judges (W2.4). Each judge gets a PAIRED pass /
 * sabotage case so the demonstrated-red is intrinsic to the suite, not a
 * one-off manual run: flip the posture and the judge must return `fail`.
 *
 * These are pure over their inputs — no server boots here. The live boot +
 * scan is exercised by `node scripts/security/dast-scan.mjs` (the nightly
 * lane); this file guards the verdict logic those probes depend on.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  judgeCookieFlags,
  judgeCorsVerdict,
  judgeHostVerdict,
  judgeJsonNosniff,
  judgeMethodVerdict,
  summarize,
} from "./dast-scan.mjs";

test("judgeJsonNosniff: JSON with nosniff passes, without fails", () => {
  const good = judgeJsonNosniff({
    target: "t",
    contentType: "application/json; charset=utf-8",
    nosniff: "nosniff",
    boundary: false,
  });
  assert.equal(good.verdict, "pass");

  const bad = judgeJsonNosniff({
    target: "t",
    contentType: "application/json; charset=utf-8",
    nosniff: null,
    boundary: true,
  });
  assert.equal(bad.verdict, "fail");
  assert.equal(bad.pinKey, "header.boundary-response-nosniff");
});

test("judgeJsonNosniff: non-JSON responses are not judged here", () => {
  const skipped = judgeJsonNosniff({
    target: "t",
    contentType: "text/html",
    nosniff: null,
    boundary: false,
  });
  assert.equal(skipped, null);
});

test("judgeCookieFlags: flagged cookie passes, bare cookie fails each flag", () => {
  const good = judgeCookieFlags({
    target: "t",
    setCookie: "sid=abc; HttpOnly; SameSite=Strict; Secure; Path=/",
    isHttps: true,
  });
  assert.ok(good.every((f) => f.verdict === "pass"));

  const bad = judgeCookieFlags({
    target: "t",
    setCookie: "sid=abc; Path=/",
    isHttps: true,
  });
  const failed = bad.filter((f) => f.verdict === "fail").map((f) => f.pinKey);
  assert.deepEqual(
    new Set(failed),
    new Set(["cookie.httponly", "cookie.samesite", "cookie.secure"])
  );
});

test("judgeCookieFlags: Secure only required over HTTPS", () => {
  const overHttp = judgeCookieFlags({
    target: "t",
    setCookie: "sid=abc; HttpOnly; SameSite=Lax",
    isHttps: false,
  });
  // HttpOnly + SameSite present, Secure not demanded on plain HTTP.
  assert.ok(overHttp.every((f) => f.verdict === "pass"));
  assert.ok(!overHttp.some((f) => f.pinKey === "cookie.secure"));
});

test("judgeCorsVerdict: bearer/bound origin must be reflected WITH credentials", () => {
  const good = judgeCorsVerdict({
    target: "t",
    origin: "http://127.0.0.1:4173",
    acao: "http://127.0.0.1:4173",
    acac: "true",
    expectCredentialed: true,
  });
  assert.equal(good.verdict, "pass");

  const bad = judgeCorsVerdict({
    target: "t",
    origin: "http://127.0.0.1:4173",
    acao: "*",
    acac: null,
    expectCredentialed: true,
  });
  assert.equal(bad.verdict, "fail");
});

test("judgeCorsVerdict: foreign origin reflected WITH credentials is the classic hole", () => {
  const safe = judgeCorsVerdict({
    target: "t",
    origin: "http://evil.example",
    acao: "*",
    acac: null,
    expectCredentialed: false,
  });
  assert.equal(safe.verdict, "pass");

  const hole = judgeCorsVerdict({
    target: "t",
    origin: "http://evil.example",
    acao: "http://evil.example",
    acac: "true",
    expectCredentialed: false,
  });
  assert.equal(hole.verdict, "fail");
  assert.equal(hole.pinKey, "cors.foreign-reflected-with-credentials");
});

test("judgeMethodVerdict: unauth verb must be 4xx, a silent 2xx fails", () => {
  const refused = judgeMethodVerdict({
    target: "t",
    method: "DELETE",
    status: 401,
    expectation: "refused",
  });
  assert.equal(refused.verdict, "pass");

  const silent = judgeMethodVerdict({
    target: "t",
    method: "DELETE",
    status: 200,
    expectation: "refused",
  });
  assert.equal(silent.verdict, "fail");
  assert.equal(silent.severity, "high");
});

test("judgeMethodVerdict: OPTIONS preflight must be 204", () => {
  const good = judgeMethodVerdict({
    target: "t",
    method: "OPTIONS",
    status: 204,
    expectation: "preflight",
  });
  assert.equal(good.verdict, "pass");

  const bad = judgeMethodVerdict({
    target: "t",
    method: "OPTIONS",
    status: 200,
    expectation: "preflight",
  });
  assert.equal(bad.verdict, "fail");
});

test("judgeHostVerdict: foreign Host must be 400 invalid_host", () => {
  const good = judgeHostVerdict({
    target: "t",
    status: 400,
    body: JSON.stringify({ error: "invalid_host", message: "no" }),
  });
  assert.equal(good.verdict, "pass");

  const accepted = judgeHostVerdict({
    target: "t",
    status: 200,
    body: JSON.stringify({ ok: true }),
  });
  assert.equal(accepted.verdict, "fail");

  const wrongError = judgeHostVerdict({
    target: "t",
    status: 400,
    body: "not json",
  });
  assert.equal(wrongError.verdict, "fail");
});

test("summarize: pinned failures do not turn the lane red; unpinned ones do", () => {
  const findings = [
    {
      pinKey: "header.boundary-response-nosniff",
      verdict: "fail",
      category: "header",
    },
    {
      pinKey: "cors.foreign-reflected-with-credentials",
      verdict: "fail",
      category: "cors",
    },
    { pinKey: "method.silent-success", verdict: "pass", category: "method" },
  ];
  const pinRegister = { "header.boundary-response-nosniff": { issue: 0 } };
  const summary = summarize(findings, pinRegister);
  assert.equal(summary.totals.pinned, 1);
  assert.equal(summary.totals.failed, 1);
  assert.equal(summary.totals.passed, 1);
  assert.equal(summary.green, false);

  const allPinned = summarize(
    [
      {
        pinKey: "header.boundary-response-nosniff",
        verdict: "fail",
        category: "header",
      },
    ],
    pinRegister
  );
  assert.equal(allPinned.green, true);
});
