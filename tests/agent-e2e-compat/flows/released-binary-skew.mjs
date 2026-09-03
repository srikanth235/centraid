import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { judgeSkewJourney, resolveReleasedClient } from "../lib/skew.mjs";

const client = resolveReleasedClient(process.env);

if (!client.available) {
  const { verdict, reason } = judgeSkewJourney(client);
  report(verdict, reason);
  process.exit(0);
}

let source = client.source;
if (client.kind === "tag") {
  source = await downloadReleasedClient(client.source);
}

const driverPath = path.join(source, "skew-driver.mjs");
if (!existsSync(driverPath)) {
  report(
    "fail",
    `released client at ${source} has no skew-driver.mjs — cannot drive the skew journey`
  );
  process.exit(1);
}

const { default: drive } = await import(pathToFileURL(driverPath).href);
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

async function downloadReleasedClient(tag) {
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
