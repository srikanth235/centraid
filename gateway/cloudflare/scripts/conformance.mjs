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
import process from "node:process";

const PORT = Number(process.env.CONFORMANCE_PORT ?? 8787);
const READY_PATTERN = /Ready on http:\/\/(?:localhost|127\.0\.0\.1):(\d+)/i;
// Miniflare has to compile the Worker to wasm on the first run, which is a
// cargo build. Minutes, not seconds, and a short timeout here reads as a
// conformance failure when it is a cold cache.
const START_TIMEOUT_MS = Number(process.env.CONFORMANCE_START_TIMEOUT_MS ?? 900_000);

function fail(message) {
  process.stderr.write(`conformance: ${message}\n`);
  process.exit(1);
}

async function main() {
  const wrangler = spawn(
    "npx",
    ["--yes", "wrangler", "dev", "--env", "dev", "--port", String(PORT), "--local"],
    { cwd: new URL("..", import.meta.url).pathname, stdio: ["ignore", "pipe", "pipe"] },
  );

  let output = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`wrangler did not become ready in ${START_TIMEOUT_MS}ms:\n${output}`)),
      START_TIMEOUT_MS,
    );
    const watch = (chunk) => {
      const text = String(chunk);
      output += text;
      process.stderr.write(text);
      if (READY_PATTERN.test(output)) {
        clearTimeout(timer);
        resolve();
      }
    };
    wrangler.stdout.on("data", watch);
    wrangler.stderr.on("data", watch);
    wrangler.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`wrangler exited with ${code} before becoming ready:\n${output}`));
    });
  });

  try {
    await ready;
    const answer = await fetch(`http://127.0.0.1:${PORT}/__conformance`, { method: "POST" });
    const report = await answer.text();
    process.stdout.write(report);
    if (!answer.ok) {
      fail(`the Worker answered ${answer.status}`);
    }
    // THE LAST LINE IS THE VERDICT, and a report with neither verdict is a
    // route that answered something else entirely — which must not read as a
    // pass.
    const verdict = report.trimEnd().split("\n").at(-1);
    if (verdict !== "GREEN") {
      fail(verdict === "RED" ? "the suite failed against this adapter" : `no verdict: ${verdict}`);
    }
    process.stdout.write("conformance: GREEN against the Cloudflare adapter\n");
  } catch (error) {
    fail(error.message);
  } finally {
    wrangler.kill("SIGTERM");
  }
}

await main();
