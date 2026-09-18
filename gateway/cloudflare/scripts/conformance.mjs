#!/usr/bin/env node
// THE SHARED SUITE, AGAINST THIS WORKER UNDER MINIFLARE (#1029 §3).
//
// `conformance::run` is a library function precisely so that more than one
// adapter can drive it: `cargo test` cannot reach inside a Worker, so a suite
// that lived in a `#[test]` could only ever have checked one of the two things
// it exists to compare. This script is the Worker's caller.
//
// It starts `wrangler dev --env dev` — which is Miniflare, with a real Durable
// Object and a real R2 bucket, both local — posts `/__conformance`, prints the
// report the Worker rendered, and exits non-zero on `RED`.
//
// WHY THE VERDICT IS A LINE AND NOT AN EXIT CODE FROM THE WORKER: a Worker has
// no test harness to catch a panic, and a suite that aborted on its first
// failure would tell an adapter author one thing per run. The suite returns a
// report of every case; this reads the last line.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import process from "node:process";

const PORT = Number(process.env.CONFORMANCE_PORT ?? 8787);
// READINESS IS A PROBE, NOT A LOG LINE. Matching wrangler's own output couples
// this script to wording that changes between releases, and the failure mode is
// a run that waits out its timeout while a perfectly healthy server sits on the
// port. Asking the server is version-proof.
const PROBE_INTERVAL_MS = 1_000;
// Miniflare has to compile the Worker to wasm on the first run, which is a
// cargo build. Minutes, not seconds, and a short timeout here reads as a
// conformance failure when it is a cold cache.
const START_TIMEOUT_MS = Number(process.env.CONFORMANCE_START_TIMEOUT_MS ?? 900_000);

// THE LOCAL SECRETS, WRITTEN RATHER THAN COMMITTED.
//
// `wrangler dev` loads `.dev.vars` as the Worker's SECRETS, which is how
// `env.secret(…)` answers anything under Miniflare. Without it the suite fails
// at the first `declare` with "this Worker has no R2 S3 credentials" — the
// presigner refusing correctly and telling you nothing about the rules.
//
// It is written here and not checked in because `.gitignore` excludes
// `**/.dev.vars` for every project in this repository, and a secrets file that
// one directory is exempt from is an exemption somebody will copy. Writing it
// keeps the rule intact and keeps a fresh checkout able to run this with
// nothing set up first.
//
// THESE ARE NOT CREDENTIALS: they are AWS's own SigV4 documentation values,
// they open no bucket, and the suite never fetches a URL signed with them — the
// harness uploads through the R2 binding, exactly where a presigned PUT would
// have landed.
const DEV_VARS = [
  'R2_ACCESS_KEY_ID = "AKIDEXAMPLE"',
  'R2_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"',
  "",
].join("\n");

function fail(message) {
  process.stderr.write(`conformance: ${message}\n`);
  process.exit(1);
}

async function main() {
  const root = new URL("..", import.meta.url).pathname;
  writeFileSync(`${root}/.dev.vars`, DEV_VARS);

  const wrangler = spawn(
    "npx",
    [
      "--yes",
      "wrangler",
      "dev",
      // `--config` IS NOT OPTIONAL HERE. This repository has a `wrangler.json`
      // at its root for the public site, and wrangler walks UP from its working
      // directory looking for one — so without this it configures itself from
      // the site's file, reports "no environment named dev", and fails on a
      // missing assets directory. A confusing error a long way from its cause.
      "--config",
      "wrangler.toml",
      "--env",
      "dev",
      "--port",
      String(PORT),
      "--local",
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );

  let output = "";
  let exited = null;
  const watch = (chunk) => {
    const text = String(chunk);
    output += text;
    process.stderr.write(text);
  };
  wrangler.stdout.on("data", watch);
  wrangler.stderr.on("data", watch);
  wrangler.on("exit", (code) => {
    exited = code;
  });

  const ready = async () => {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exited !== null) {
        throw new Error(`wrangler exited with ${exited} before becoming ready:\n${output}`);
      }
      try {
        const probe = await fetch(`http://127.0.0.1:${PORT}/version`);
        if (probe.ok) {
          return;
        }
      } catch {
        // Not up yet.
      }
      await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
    }
    throw new Error(`wrangler did not answer in ${START_TIMEOUT_MS}ms:\n${output}`);
  };

  const run = async (query, label) => {
    const answer = await fetch(`http://127.0.0.1:${PORT}/__conformance${query}`, {
      method: "POST",
    });
    const report = await answer.text();
    process.stdout.write(`--- ${label} ---\n${report}`);
    if (!answer.ok) {
      fail(`the Worker answered ${answer.status} for ${label}`);
    }
    // THE LAST LINE IS THE VERDICT, and a report with neither verdict is a
    // route that answered something else entirely — which must not read as a
    // pass.
    return report.trimEnd().split("\n").at(-1);
  };

  try {
    await ready();
    const green = await run("", "the suite against this adapter");
    if (green !== "GREEN") {
      fail(green === "RED" ? "the suite failed against this adapter" : `no verdict: ${green}`);
    }
    // AND THE SUITE HAS TO BE ABLE TO FAIL. A harness that drops uploads on the
    // floor must go red, or the green above is satisfied by a harness that
    // quietly did nothing.
    const forgetful = await run("?forgetful=1", "a harness that stores nothing");
    if (forgetful !== "GREEN") {
      fail(
        forgetful === "FORGETFUL-GREEN"
          ? "a harness that stores nothing PASSED the suite against this adapter"
          : `no verdict: ${forgetful}`,
      );
    }
    process.stdout.write("conformance: GREEN against the Cloudflare adapter\n");
  } catch (error) {
    fail(error.message);
  } finally {
    wrangler.kill("SIGTERM");
  }
}

await main();

// EXIT EXPLICITLY. `wrangler`'s pipes keep node's event loop alive after the
// verdict is printed, so without this the script hangs on success — which in
// CI is a job that times out after a green run and reports red.
process.exit(0);
