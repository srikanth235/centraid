// W5.3 (#842) — unit pins for the released-binary skew judge. `node --test`.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SKEW_BLOCKERS,
  judgeSkewJourney,
  resolveReleasedClient,
} from "./skew.mjs";

test("resolveReleasedClient: no env → blocked-external skip with citation", () => {
  const r = resolveReleasedClient({});
  assert.equal(r.available, false);
  assert.equal(r.reason, SKEW_BLOCKERS.noRelease);
});

test("resolveReleasedClient: blank env is treated as absent", () => {
  const r = resolveReleasedClient({
    CENTRAID_SKEW_CLIENT_DIR: "   ",
    CENTRAID_SKEW_RELEASE_TAG: "",
  });
  assert.equal(r.available, false);
});

test("resolveReleasedClient: extracted dir wins and is reported as a dir", () => {
  const r = resolveReleasedClient({ CENTRAID_SKEW_CLIENT_DIR: "/tmp/client" });
  assert.deepEqual(r, { available: true, kind: "dir", source: "/tmp/client" });
});

test("resolveReleasedClient: a release tag resolves to a tag source", () => {
  const r = resolveReleasedClient({ CENTRAID_SKEW_RELEASE_TAG: "v0.3.0" });
  assert.deepEqual(r, { available: true, kind: "tag", source: "v0.3.0" });
});

test("judgeSkewJourney: not available → skip carries the reason", () => {
  const v = judgeSkewJourney({ available: false, reason: "no release yet" });
  assert.equal(v.verdict, "skip");
  assert.match(v.reason, /no release yet/u);
});

test("judgeSkewJourney: available but never ran → fail, not vacuous skip", () => {
  const v = judgeSkewJourney({ available: true, ran: false });
  assert.equal(v.verdict, "fail");
  assert.match(v.reason, /vacuous/u);
});

test("judgeSkewJourney: ran but pairing broke → fail names the skew", () => {
  const v = judgeSkewJourney({
    available: true,
    ran: true,
    paired: false,
    clientVersion: "0.2.0",
    gatewayVersion: "0.3.0",
  });
  assert.equal(v.verdict, "fail");
  assert.match(v.reason, /0\.2\.0.*0\.3\.0/u);
});

test("judgeSkewJourney: paired but replica diverged → fail", () => {
  const v = judgeSkewJourney({
    available: true,
    ran: true,
    paired: true,
    replicaConverged: false,
  });
  assert.equal(v.verdict, "fail");
  assert.match(v.reason, /converge/u);
});

test("judgeSkewJourney: full journey green → pass", () => {
  const v = judgeSkewJourney({
    available: true,
    ran: true,
    paired: true,
    replicaConverged: true,
    clientVersion: "0.2.0",
    gatewayVersion: "0.3.0",
  });
  assert.equal(v.verdict, "pass");
});

test("judgeSkewJourney: non-object result → fail", () => {
  assert.equal(judgeSkewJourney(null).verdict, "fail");
});
