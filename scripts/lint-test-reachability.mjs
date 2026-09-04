#!/usr/bin/env bun
// Every test file in the tree is reached by some runner (#931 item 1).
//
// `scripts/validate-ui-receipt.test.mjs` imported `vitest`, sat in no vitest
// project, and was absent from `scripts:test`'s `node --test` list. Its cases
// had never run, and nothing in the repo could have said so: vitest reports
// "no file matched this project's include" as a green suite, and `node --test`
// only runs the files it is handed. `coverage-scope-reachability` asks the same
// question of SOURCE trees; until this gate, tests had no equivalent.
//
// A test file counts as REACHED when one of these is true:
//
//   1. it matches the `include` (and survives the `exclude`) of some vitest
//      project — the repo-wide run's projects, plus the standalone configs
//      listed in RUNNERS below;
//   2. it is named as an argument in a root `package.json` script (that is how
//      `node --test` lanes take their files);
//   3. it lives under a Playwright `testDir` and matches Playwright's spec
//      pattern.
//
// It deliberately runs under BUN rather than node: the vitest configs are
// TypeScript modules that compose each other (`apps/mobile/vitest.projects.ts`
// builds its two projects from one shared array), so the only faithful way to
// read an `include` is to import the module and look at the object vitest
// itself would receive. A regex over the config text would answer a different
// question — "what does the file look like" — and would go quietly wrong the
// first time a project list is built rather than written out.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

/**
 * The vitest configs that are entry points — a command runs them directly.
 *
 * `cwd` matters and is not cosmetic: vitest resolves a project's `include`
 * against the project ROOT, and the root defaults to the process CWD rather
 * than to the config file's own folder (the comment in
 * `tests/integration-mobile/vitest.config.ts` is about exactly this). So the
 * lane's working directory is part of what the config means, and it is recorded
 * here beside the config it belongs to.
 *
 * Configs NOT listed here are reached another way and must stay that way:
 * `vitest.quality.config.ts` is a project of the root config; the
 * `vitest.*mutation.config.ts` family is Stryker's, and every file it names is
 * also inside its package's own project; `vitest.diff-coverage.config.ts` and
 * `vitest.shard.config.ts` re-use `coverageProjects` from the root config.
 * `assertEveryConfigModelled` below fails when a config appears that is none of
 * those things, so this list cannot silently fall behind the tree.
 */
export const RUNNERS = Object.freeze([
  { config: "vitest.config.ts", cwd: "." },
  { config: "vitest.perf.config.ts", cwd: "." },
  { config: "vitest.scale.config.ts", cwd: "." },
  // `bun run perf:waterfall` — the rung-0 developer command (#927). One file,
  // eight apps; it is a vitest project only because the year-3 fixture ships as
  // TypeScript sources.
  { config: "vitest.waterfall.config.ts", cwd: "." },
  { config: "scripts/test-report/vitest.config.ts", cwd: "." },
  { config: "scripts/fuzz/vitest.config.ts", cwd: "." },
  { config: "scripts/release/vitest.config.ts", cwd: "." },
  { config: "tests/integration-mobile/vitest.config.ts", cwd: "." },
  // `bun run --cwd packages/model-runtime test:live` — the real-weight lane.
  {
    config: "packages/model-runtime/vitest.live.config.ts",
    cwd: "packages/model-runtime",
  },
]);

/** Configs that are reached without being an entry point of their own. */
const NOT_ENTRY_POINTS = [
  // A project of the root config.
  "vitest.quality.config.ts",
  // Same `coverageProjects` list as the root config, different reporters.
  "vitest.diff-coverage.config.ts",
  "vitest.shard.config.ts",
];

/** Playwright's default `testMatch`. */
const PLAYWRIGHT_SPECS = "**/*.@(spec|test).?(c|m)[jt]s?(x)";

/** Anything named `*.test.*` / `*.spec.*` is a test file this gate is about. */
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

/**
 * Compile one picomatch-style glob to a RegExp anchored at both ends.
 *
 * Supports what the repo's configs actually use: `**`, `*`, `?`, `{a,b}` and
 * the extglob forms `?(…)`, `@(…)`, `+(…)`, `*(…)`. An unsupported construct
 * throws rather than silently compiling to something that matches too much — a
 * reachability gate that over-matches reports every orphan as reached.
 *
 * @param {string} glob The pattern, relative and `/`-separated.
 * @returns {RegExp} The compiled matcher.
 */
export function globToRegExp(glob) {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*") {
      const doubled = glob[i + 1] === "*";
      if (doubled && glob[i + 2] === "/") {
        // `**/` matches zero or more leading directories.
        out += "(?:[^/]+/)*";
        i += 3;
        continue;
      }
      if (doubled) {
        out += ".*";
        i += 2;
        continue;
      }
      if (glob[i + 1] === "(") {
        const { body, next } = extglob(glob, i + 1);
        out += `(?:${body})*`;
        i = next;
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (
      (ch === "?" || ch === "@" || ch === "+" || ch === "!") &&
      glob[i + 1] === "("
    ) {
      if (ch === "!") throw new Error(`unsupported extglob !( in ${glob}`);
      const { body, next } = extglob(glob, i + 1);
      out +=
        ch === "?"
          ? `(?:${body})?`
          : ch === "+"
            ? `(?:${body})+`
            : `(?:${body})`;
      i = next;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if (ch === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close === -1)
        throw new Error(`unterminated character class in ${glob}`);
      const body = glob.slice(i + 1, close);
      out += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
      i = close + 1;
      continue;
    }
    if (ch === "{") {
      const { body, next } = braces(glob, i);
      out += `(?:${body})`;
      i = next;
      continue;
    }
    out += escapeLiteral(ch);
    i += 1;
  }
  return new RegExp(`^${out}$`, "u");
}

/** Escape one literal character for use inside a RegExp source. */
function escapeLiteral(ch) {
  return /[.+^$()[\]\\|]/u.test(ch) ? `\\${ch}` : ch;
}

/**
 * Compile the `(a|b)` payload of an extglob starting at `open`.
 * @param {string} glob The whole pattern.
 * @param {number} open Index of the `(`.
 * @returns {{body: string, next: number}} The compiled alternation and the index after `)`.
 */
function extglob(glob, open) {
  const close = glob.indexOf(")", open);
  if (close === -1) throw new Error(`unterminated extglob in ${glob}`);
  const body = glob
    .slice(open + 1, close)
    .split("|")
    .map((part) => globToRegExp(part).source.slice(1, -1))
    .join("|");
  return { body, next: close + 1 };
}

/**
 * Compile a `{a,b}` brace expansion starting at `open`.
 * @param {string} glob The whole pattern.
 * @param {number} open Index of the `{`.
 * @returns {{body: string, next: number}} The compiled alternation and the index after `}`.
 */
function braces(glob, open) {
  const close = glob.indexOf("}", open);
  if (close === -1) throw new Error(`unterminated brace in ${glob}`);
  const body = glob
    .slice(open + 1, close)
    .split(",")
    .map((part) => globToRegExp(part).source.slice(1, -1))
    .join("|");
  return { body, next: close + 1 };
}

/**
 * Does `file` match any of `patterns`?
 * @param {string} file A path relative to the project root, `/`-separated.
 * @param {readonly string[]} patterns Globs or literal relative paths.
 * @returns {boolean} True on the first match.
 */
export function matchesAny(file, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(file));
}

/**
 * Flatten a loaded vitest config into the concrete projects it defines.
 *
 * @param {object} config The object `defineConfig`/`defineProject` returned.
 * @param {string} projectRoot Absolute directory the project's globs resolve against.
 * @param {(rel: string, root: string) => Promise<object>} load Reads another config file.
 * @returns {Promise<{root: string, include: string[], exclude: string[]}[]>} Leaf projects.
 */
export async function flattenProjects(config, projectRoot, load) {
  const test = config?.test ?? {};
  const declaredRoot = config?.root
    ? path.resolve(projectRoot, config.root)
    : projectRoot;
  const children = test.projects ?? config?.projects;
  if (Array.isArray(children)) {
    const expanded = await Promise.all(
      children.map(async (child) => {
        if (typeof child !== "string") {
          return flattenProjects(child, declaredRoot, load);
        }
        const target = path.resolve(declaredRoot, child);
        // A project entry is either a config file or a package directory; a
        // directory's project root is the directory itself, and a config
        // file's is the folder that holds it.
        const isFile = /\.[cm]?[jt]s$/u.test(child);
        const rel = path.relative(
          ROOT,
          isFile ? target : path.join(target, "vitest.config.ts")
        );
        const childRoot = isFile ? path.dirname(target) : target;
        return flattenProjects(await load(rel, childRoot), childRoot, load);
      })
    );
    return expanded.flat();
  }
  return [
    {
      root: declaredRoot,
      include: test.include ?? ["**/*.{test,spec}.?(c|m)[jt]s?(x)"],
      exclude: test.exclude ?? [],
    },
  ];
}

/** Load one config module and hand back the object vitest would see. */
async function loadConfig(rel) {
  const mod = await import(path.join(ROOT, rel));
  return mod.default ?? mod;
}

/**
 * Every leaf vitest project, across every runner.
 * @returns {Promise<{root: string, include: string[], exclude: string[]}[]>} Projects.
 */
export async function collectProjects() {
  const perRunner = await Promise.all(
    RUNNERS.map(async (runner) =>
      flattenProjects(
        await loadConfig(runner.config),
        path.resolve(ROOT, runner.cwd),
        (rel) => loadConfig(rel)
      )
    )
  );
  return perRunner.flat();
}

/**
 * Every test file argument named by a root `package.json` script.
 *
 * Not just `scripts:test`: `gateway:npm:helpers:test`, `test:accessibility` and
 * the rest all hand `node --test` their own file lists, and a file named by any
 * of them is a file some lane runs.
 *
 * @param {object} scripts The `scripts` block.
 * @returns {Set<string>} Repo-relative paths.
 */
export function filesNamedByScripts(scripts) {
  const named = JSON.stringify(scripts ?? {}).match(
    /[\w./@-]+\.(?:test|spec)\.[cm]?[jt]sx?/gu
  );
  return named ? new Set(named) : new Set();
}

/**
 * The directories a Playwright config owns.
 *
 * Read textually rather than imported: importing a Playwright config pulls in
 * the whole `@playwright/test` runner for one string. Both configs in the tree
 * set `testDir` to their own folder, and a `testDir` this cannot resolve is an
 * error rather than a silent empty answer.
 *
 * @param {string[]} configs Repo-relative paths to `playwright*.config.ts`.
 * @param {(rel: string) => string} read Reads a file.
 * @returns {{dir: string, config: string}[]} Repo-relative test directories.
 */
export function playwrightDirs(configs, read) {
  return configs.map((config) => {
    const source = read(config);
    const match = /testDir:\s*(?<value>[^,\n]+)/u.exec(source);
    if (!match) throw new Error(`${config}: no testDir to read`);
    const value = match.groups.value.trim();
    if (/^(?:here|__dirname|import\.meta\.dirname)$/u.test(value)) {
      return { dir: path.dirname(config), config };
    }
    const literal = /^["'`](?<path>[^"'`]*)["'`]$/u.exec(value);
    if (literal) {
      return {
        dir: path.normalize(
          path.join(path.dirname(config), literal.groups.path)
        ),
        config,
      };
    }
    throw new Error(
      `${config}: testDir ${value} is not a folder this gate can resolve`
    );
  });
}

/**
 * The orphans: test files no runner reaches.
 *
 * @param {object} input Tracked files, projects, script-named files and Playwright dirs.
 * @param {string[]} input.files Every tracked path, repo-relative.
 * @param {{root: string, include: string[], exclude: string[]}[]} input.projects Leaf vitest projects.
 * @param {Set<string>} input.named Files a package.json script hands a runner.
 * @param {{dir: string}[]} input.playwright Playwright test directories.
 * @returns {string[]} Repo-relative paths, sorted.
 */
export function findOrphans({ files, projects, named, playwright }) {
  const orphans = [];
  for (const file of files) {
    if (!TEST_FILE.test(path.basename(file))) continue;
    if (named.has(file)) continue;
    if (
      playwright.some(
        ({ dir }) =>
          file.startsWith(`${dir}/`) &&
          matchesAny(file.slice(dir.length + 1), [PLAYWRIGHT_SPECS])
      )
    ) {
      continue;
    }
    const absolute = path.join(ROOT, file);
    const reached = projects.some((project) => {
      if (!absolute.startsWith(`${project.root}${path.sep}`)) return false;
      const relative = path.relative(project.root, absolute);
      if (project.exclude.length > 0 && matchesAny(relative, project.exclude))
        return false;
      return matchesAny(relative, project.include);
    });
    if (!reached) orphans.push(file);
  }
  return orphans.sort();
}

/**
 * Every `vitest*.config.ts` in the tree is either a listed runner, a config a
 * runner composes, or one of the deliberately-not-an-entry-point shapes.
 *
 * @param {string[]} configs Repo-relative config paths.
 * @param {{root: string}[]} projects The leaf projects that were loaded.
 * @returns {string[]} Failures, one per unmodelled config.
 */
export function assertEveryConfigModelled(configs, projects) {
  const listed = new Set(RUNNERS.map((runner) => runner.config));
  const roots = new Set(projects.map((project) => project.root));
  const failures = [];
  for (const config of configs) {
    if (listed.has(config)) continue;
    if (NOT_ENTRY_POINTS.includes(config)) continue;
    // Stryker's own roots: every file they name also lives in the package's
    // project, so they add no reachability of their own.
    if (/vitest\.[\w.-]*mutation\.config\.[cm]?ts$/u.test(config)) continue;
    // A per-package `vitest.config.ts` composed by the root config.
    if (
      path.basename(config) === "vitest.config.ts" &&
      roots.has(path.resolve(ROOT, path.dirname(config)))
    ) {
      continue;
    }
    failures.push(
      `${config} is a vitest config no runner in scripts/lint-test-reachability.mjs names — ` +
        `add it to RUNNERS (with the cwd its lane runs from) or to NOT_ENTRY_POINTS with the reason`
    );
  }
  return failures;
}

/**
 * Run the gate over this repository.
 * @returns {Promise<{orphans: string[], failures: string[], scanned: number}>} The verdict.
 */
export async function run() {
  const tracked = execFileSync("git", ["ls-files"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  const projects = await collectProjects();
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const configs = tracked.filter((file) =>
    /(?:^|\/)vitest[\w.-]*\.config\.[cm]?ts$/u.test(file)
  );
  const playwright = playwrightDirs(
    tracked.filter((file) =>
      /(?:^|\/)playwright[\w.-]*\.config\.[cm]?ts$/u.test(file)
    ),
    (rel) => readFileSync(path.join(ROOT, rel), "utf8")
  );
  const orphans = findOrphans({
    files: tracked,
    projects,
    named: filesNamedByScripts(pkg.scripts),
    playwright,
  });
  return {
    orphans,
    failures: assertEveryConfigModelled(configs, projects),
    scanned: tracked.filter((file) => TEST_FILE.test(path.basename(file)))
      .length,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  if (!existsSync(path.join(ROOT, "package.json"))) {
    console.error("test-reachability: run from the repository");
    process.exit(2);
  }
  const { orphans, failures, scanned } = await run();
  for (const failure of failures)
    console.error(`test-reachability: ${failure}`);
  for (const orphan of orphans) {
    console.error(
      `test-reachability: ${orphan} is matched by no vitest project's include, ` +
        `is named by no package.json script, and is owned by no Playwright config — its cases never run`
    );
  }
  if (orphans.length > 0 || failures.length > 0) process.exit(1);
  console.log(
    `test-reachability: ${scanned} test files, every one reached by a runner`
  );
}
