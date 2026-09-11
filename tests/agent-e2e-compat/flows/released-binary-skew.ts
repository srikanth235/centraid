// W5.3 (#842) — released-binary skew lane runner.
//
// Tonight's gateway (built from source by the pairing harness) must still pair
// and converge replicas with the LAST PUBLISHED client — the real skew a
// household lives with when one device upgrades before another. See the .md
// next to this file for intent, and lib/skew.mjs for the pure judge this driver
// delegates every verdict to.
//
// CURRENT STATE: blocked-external. No client artifact has been published yet
// (the W6 release workstream cuts the first one), so the download step has
// nothing to fetch and the lane SKIPS WITH CITATION — green, but loud, and
// tracked. The moment a release exists, point CENTRAID_SKEW_RELEASE_TAG (or an
// already-extracted CENTRAID_SKEW_CLIENT_DIR) at it and the live path below
// drives the real journey. Setting either without a real artifact does NOT pass
// vacuously: the judge fails an available-but-didn't-run result.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { judgeSkewJourney, resolveReleasedClient } from "../lib/skew.mjs";

const client = resolveReleasedClient(process.env);

// Blocked-external: emit the citation and exit green. A nightly job can run
// this lane every night and stay honest — the skip is visible in the log and
// the matrix gap tracks the unblock (W6 / releases-exist).
if (!client.available) {
  const { verdict, reason } = judgeSkewJourney(client);
  report(verdict, reason);
  // A skip is not a failure — the rig genuinely does not exist yet.
  process.exit(0);
}

// --- Live path (runs once a released client exists) -------------------------
// The released client tree must ship a skew driver at `<source>/skew-driver.mjs`
// exporting `default async ({ gateway, ticket }) => ({ paired, replicaConverged,
// clientVersion })`. The W6 release artifact provides it; the fixture under
// tests/agent-e2e-compat/fixtures/skew-client provides one for plumbing proof.
let source = client.source;
if (client.kind === "tag") {
  source = await downloadReleasedClient(client.source);
}

const driverPath = path.join(source, "skew-driver.mjs");
if (!existsSync(driverPath)) {
  // available-but-can't-drive is a FAIL, never a silent pass — the artifact is
  // present but does not expose the skew driver contract.
  report(
    "fail",
    `released client at ${source} has no skew-driver.mjs — cannot drive the skew journey`
  );
  process.exit(1);
}

const { default: drive } = await import(pathToFileURL(driverPath).href);
// runFlow boots tonight's source gateway and mints a ticket against it; the
// released client redeems that ticket. Imported lazily so the blocked-external
// skip above never pays the harness build cost.
const { runFlow } = await import("../../agent-e2e-pairing/lib/harness.mjs");

let result = { available: true, ran: false };
await runFlow("released-binary-skew", async (ctx) => {
  const { payload } = await ctx.mintTicket({ vault: "Personal" });
  const journey = await drive({
    gateway: { url: payload.gw, ticketId: payload.t, secret: payload.s },
    ticket: payload,
    note: ctx.note,
  });
  result = {
    available: true,
    ran: true,
    paired: Boolean(journey?.paired),
    replicaConverged: Boolean(journey?.replicaConverged),
    clientVersion: journey?.clientVersion,
    gatewayVersion: payload?.version ?? "source",
  };
});

const { verdict, reason } = judgeSkewJourney(result);
report(verdict, reason);
process.exit(verdict === "fail" ? 1 : 0);

// ---------------------------------------------------------------------------

async function downloadReleasedClient(tag) {
  // `gh release download` into a temp dir. Guarded: a missing gh or a
  // non-existent tag fails loudly rather than proceeding on an empty dir.
  const dest = path.join(process.env.RUNNER_TEMP || "/tmp", `skew-${tag}`);
  const run = spawnSync(
    "gh",
    ["release", "download", tag, "--dir", dest, "--pattern", "client-*"],
    { stdio: "inherit" }
  );
  if (run.status !== 0) {
    report("fail", `gh release download ${tag} failed (status ${run.status})`);
    process.exit(1);
  }
  return dest;
}

function report(outcome, detail) {
  console.log(`[released-binary-skew] ${outcome.toUpperCase()}: ${detail}`);
  if (outcome === "skip") {
    console.log(`::warning::released-binary-skew skipped — ${detail}`);
  } else if (outcome === "fail") {
    console.log(`::error::released-binary-skew failed — ${detail}`);
  }
}
