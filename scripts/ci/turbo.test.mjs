// One cache directory, chosen the same way by every turbo entry point (#988).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";

import { turboCacheDir, turboEnv } from "./turbo.mjs";

function withEnv(overrides, body) {
  const saved = { ...process.env };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return body();
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

const CLEAR = {
  TURBO_CACHE_DIR: undefined,
  CENTRAID_TURBO_CACHE_DIR: undefined,
  XDG_CACHE_HOME: undefined,
};

test("the default sits under the user's cache home, never in the repo", () => {
  withEnv(CLEAR, () => {
    assert.equal(
      turboCacheDir(),
      path.join(homedir(), ".cache", "centraid", "turbo")
    );
  });
  withEnv({ ...CLEAR, XDG_CACHE_HOME: "/xdg" }, () => {
    assert.equal(turboCacheDir(), path.join("/xdg", "centraid", "turbo"));
  });
});

test("an explicit override wins, TURBO_CACHE_DIR first", () => {
  withEnv({ ...CLEAR, CENTRAID_TURBO_CACHE_DIR: "/a" }, () => {
    assert.equal(turboCacheDir(), "/a");
  });
  withEnv(
    { ...CLEAR, TURBO_CACHE_DIR: "/b", CENTRAID_TURBO_CACHE_DIR: "/a" },
    () => {
      assert.equal(turboCacheDir(), "/b");
    }
  );
});

test("turboEnv only adds the cache directory", () => {
  withEnv(CLEAR, () => {
    const env = turboEnv({ PATH: "/usr/bin" });
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.TURBO_CACHE_DIR, turboCacheDir());
  });
});

test("every root script that runs turbo goes through the launcher", () => {
  const pkg = JSON.parse(
    readFileSync(
      path.resolve(import.meta.dirname, "../../package.json"),
      "utf8"
    )
  );
  for (const [name, body] of Object.entries(pkg.scripts)) {
    // `dev:*` are turbo's persistent tasks: never cached, and they keep the
    // plain binary so an interactive run has nothing between it and its TTY.
    if (name.startsWith("dev:")) continue;
    assert.ok(
      !/(?:^|&&\s*|\|\s*)turbo\s/u.test(body),
      `${name} calls turbo directly; route it through scripts/ci/turbo.mjs so it shares the cache`
    );
  }
});
