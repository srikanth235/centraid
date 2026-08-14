#!/usr/bin/env node
/**
 * Idempotent SonarCloud project configuration for the Centraid monorepo (#671).
 *
 * Applies analysis-scope exclusions, issue-ignore multicriteria for known
 * noise rules, ensures "Centraid" quality profiles (ts/js) and quality gate
 * exist, and optionally bulk-WONTFIXes residual open issues on silenced rules.
 *
 * Auth: SONAR_TOKEN env (user token with project administer). Example:
 *   export SONAR_TOKEN=$(security find-generic-password -s sonarqube-cli -w)
 *   bun run scripts/ci/configure-sonarcloud.mjs
 *   bun run scripts/ci/configure-sonarcloud.mjs --resolve-noise
 *
 * Policy: docs/toolchain.md#sonarcloud-autoscan
 */

const ORG = "centraid";
const PROJECT = "srikanth235_centraid";
const PROFILE_NAME = "Centraid";
const GATE_NAME = "Centraid";
const API = "https://sonarcloud.io/api";

// Split so rule keys never form a `javascript:` URL literal (eslint no-script-url).
const LANG_TS = "typescript";
const LANG_JS = "javascript";
const ruleKey = (lang, id) => `${lang}:${id}`;

/**
 * Globs excluded from source analysis (Autoscan UI/API supports wildcards).
 *
 * Product signal lives under packages/* and apps/* (minus generated/harness).
 * Tooling is owned elsewhere: oxlint/knip for scripts, actionlint+CodeQL for
 * .github, Vitest for tests. Sonar way fails PRs on *any* new BUG/VULNERABILITY
 * in scanned new code — keep non-product paths out so hygiene-only PRs do not
 * red-bar on CLI noise.
 */
const SOURCE_EXCLUSIONS = [
  "**/node_modules/**",
  "**/dist/**",
  "**/coverage/**",
  "**/artifacts/**",
  "**/.turbo/**",
  "**/.astro/**",
  "**/.expo/**",
  "**/.stryker-tmp/**",
  "**/target/**",
  // Non-product surfaces (other tools own them).
  "scripts/**",
  ".github/**",
  "tests/**",
  "packages/tunnel/**",
  "packages/blueprints/visual-harness/**",
  "packages/blueprints/.app-boot/**",
  "packages/blueprints/kit/**",
  // Release-generated recognition bundles are deployed artifacts; their
  // source-of-truth lives under packages/model-runtime, where the
  // local lint/typecheck/test gates own the implementation.
  "packages/blueprints/automations/photo-ocr/automations/photo-ocr/handler.js",
  "packages/blueprints/automations/embed-image/automations/embed-image/handler.js",
  "packages/blueprints/automations/embed-text/automations/embed-text/handler.js",
  "packages/blueprints/automations/faces/automations/faces/handler.js",
  "packages/blueprints/automations/transcript/automations/transcript/handler.js",
  "packages/test-kit/**",
  "apps/web/src/generated/**",
  "apps/web/public/**",
  "apps/web/dist/**",
  "packages/**/dist/**",
  "**/centraid_web_iroh.js",
  "**/centraid-worker-iroh.js",
  "**/*.wasm",
  "**/*.map",
  "receipts/**",
  "docs/**",
  "assets/**",
  ".governance/**",
  ".githooks/**",
  ".design-sync/**",
  "ds-bundle*/**",
  // Test / fixture co-location under product packages.
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.test.mjs",
  "**/*.test.js",
  "**/*.spec.ts",
  "**/__tests__/**",
  "**/fixtures/**",
  "**/e2e/**",
];

const CPD_EXCLUSIONS = [
  "**/visual-harness/**",
  "**/generated/**",
  "**/fixtures.ts",
  "**/*fixture*",
  "**/*mock*",
  "**/kit/**",
  // The normative registry repeats the profile-lowering record shape so each
  // role's meaning, contrast obligation, and totality stay reviewable inline.
  "packages/design/src/roles.ts",
  "packages/blueprints/apps/**",
  "scripts/test-report/**",
];

const COVERAGE_EXCLUSIONS = [
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.test.mjs",
  "**/*.test.js",
  "**/*.spec.ts",
  "**/tests/**",
  "**/e2e/**",
  "**/vitest.config.*",
  "**/stryker.config.*",
  "**/visual-harness/**",
  "**/generated/**",
  "scripts/**",
  "packages/test-kit/**",
  "packages/blueprints/kit/**",
];

const TEST_INCLUSIONS = [
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.test.mjs",
  "**/*.test.js",
  "**/*.spec.ts",
  "**/tests/**",
  "**/__tests__/**",
];

/**
 * Rules silenced project-wide via issue-ignore multicriteria.
 *
 * Sonar way PR gate fails on *any* new BUG or VULNERABILITY (ratings must stay
 * A). Silence only FP / oxlint-owned / intentional-product patterns. Keep real
 * security rules active (ReDoS S5852, postMessage origin S2819, S8482, etc.).
 */
const NOISE_RULES = [
  // --- TypeScript / JavaScript style & intentional patterns ---
  ruleKey(LANG_TS, "S3358"), // nested ternary
  ruleKey(LANG_TS, "S6759"), // Readonly props
  ruleKey(LANG_TS, "S6582"), // optional chain prefer
  ruleKey(LANG_TS, "S7781"), // replaceAll prefer
  ruleKey(LANG_TS, "S7780"),
  ruleKey(LANG_TS, "S2871"), // sort without compare
  ruleKey(LANG_TS, "S4036"), // PATH inheritance
  ruleKey(LANG_TS, "S4624"), // nested templates
  ruleKey(LANG_TS, "S6551"), // object stringification
  ruleKey(LANG_TS, "S6479"), // array index keys
  ruleKey(LANG_TS, "S6767"), // unused prop types
  ruleKey(LANG_TS, "S5332"), // http:// (local gateway)
  ruleKey(LANG_TS, "S2245"), // Math.random non-crypto IDs
  ruleKey(LANG_TS, "S3776"), // cognitive complexity (oxlint/review owns god-fns)
  ruleKey(LANG_TS, "S8786"), // super-linear regex micro-smells
  ruleKey(LANG_TS, "S7785"), // prefer top-level await
  ruleKey(LANG_JS, "S3358"),
  ruleKey(LANG_JS, "S6582"),
  ruleKey(LANG_JS, "S7781"),
  ruleKey(LANG_JS, "S7780"),
  ruleKey(LANG_JS, "S2871"),
  ruleKey(LANG_JS, "S4036"),
  ruleKey(LANG_JS, "S4624"),
  ruleKey(LANG_JS, "S3504"), // var (generated noise)
  ruleKey(LANG_JS, "S5332"),
  ruleKey(LANG_JS, "S2245"),
  ruleKey(LANG_JS, "S3776"),
  ruleKey(LANG_JS, "S8786"),
  ruleKey(LANG_JS, "S6551"),
  ruleKey(LANG_JS, "S7785"),
  // --- Security FPs that are not product defects in this stack ---
  ruleKey("jssecurity", "S5145"), // "log user-controlled data" in CLIs/tooling
  ruleKey("githubactions", "S6506"), // HTTPS curl to GitHub releases (already https)
  ruleKey("githubactions", "S8543"), // unpinned npm in actions (we pin via lock/SHA)
  ruleKey("githubactions", "S8233"), // workflow-level permissions (reviewed)
];

const GATE_CONDITIONS = [
  { metric: "new_security_rating", op: "GT", error: "1" },
  { metric: "new_reliability_rating", op: "GT", error: "1" },
  { metric: "new_maintainability_rating", op: "GT", error: "1" },
  { metric: "new_duplicated_lines_density", op: "GT", error: "3" },
  { metric: "new_security_hotspots_reviewed", op: "LT", error: "100" },
];

const RESOLVE_COMMENT =
  "Centraid Sonar config: style/FP rule silenced project-wide (docs/toolchain.md#sonarcloud-autoscan).";

const BULK_CHUNK = 100;

/**
 * @returns {string} SonarCloud user token from the environment.
 */
function token() {
  const t = process.env.SONAR_TOKEN?.trim();
  if (!t) {
    console.error(
      "SONAR_TOKEN is required (SonarCloud user token with project administer)."
    );
    process.exit(2);
  }
  return t;
}

/**
 * Call a SonarCloud Web API endpoint.
 * @param {string} method HTTP method.
 * @param {string} path API path beginning with `/`.
 * @param {Record<string, string | string[] | undefined> | undefined} [form] Form body for POST.
 * @returns {Promise<{ status: number, json: unknown }>} Response status and parsed body.
 */
async function api(method, path, form) {
  const url = `${API}${path}`;
  const headers = {
    Authorization: `Basic ${Buffer.from(`${token()}:`).toString("base64")}`,
  };
  /** @type {RequestInit} */
  const init = { method, headers };
  if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) {
      if (Array.isArray(v)) {
        for (const item of v) body.append(k, item);
      } else if (v !== undefined && v !== null) {
        body.append(k, String(v));
      }
    }
    init.body = body.toString();
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }
  return { status: res.status, json };
}

/**
 * Set a multi-value project setting.
 * @param {string} key Setting key.
 * @param {string[]} values Values to store.
 * @returns {Promise<void>}
 */
async function setMulti(key, values) {
  const { status, json } = await api("POST", "/settings/set", {
    component: PROJECT,
    key,
    values,
  });
  if (status !== 204 && status !== 200) {
    throw new Error(
      `set ${key} failed HTTP ${status}: ${JSON.stringify(json)}`
    );
  }
  console.log(`  ${key}: ${values.length} values (HTTP ${status})`);
}

/**
 * Apply issue-ignore multicriteria for all noise rules.
 * @returns {Promise<void>}
 */
async function setMulticriteria() {
  const fieldValues = NOISE_RULES.map((rule) =>
    JSON.stringify({ ruleKey: rule, resourceKey: "**/*" })
  );
  const { status, json } = await api("POST", "/settings/set", {
    component: PROJECT,
    key: "sonar.issue.ignore.multicriteria",
    fieldValues,
  });
  if (status !== 204 && status !== 200) {
    throw new Error(
      `multicriteria failed HTTP ${status}: ${JSON.stringify(json)}`
    );
  }
  console.log(`  multicriteria: ${NOISE_RULES.length} rules (HTTP ${status})`);
}

/**
 * Ensure Centraid quality profiles exist for ts/js with noise rules off.
 * @returns {Promise<void>}
 */
async function ensureProfiles() {
  const { json: search } = await api(
    "GET",
    `/qualityprofiles/search?organization=${ORG}`
  );
  const profiles =
    search && typeof search === "object" && Array.isArray(search.profiles)
      ? search.profiles
      : [];
  const by = Object.fromEntries(
    profiles.map((p) => [`${p.language}:${p.name}`, p])
  );

  await ["ts", "js"].reduce(async (prev, lang) => {
    await prev;
    const way = by[`${lang}:Sonar way`];
    if (!way) {
      console.warn(`  skip profile ${lang}: no Sonar way`);
      return;
    }
    let profile = by[`${lang}:${PROFILE_NAME}`];
    if (profile) {
      console.log(`  profile ${lang} ${PROFILE_NAME} exists (${profile.key})`);
    } else {
      const { status, json } = await api("POST", "/qualityprofiles/copy", {
        fromKey: way.key,
        toName: PROFILE_NAME,
      });
      console.log(
        `  copy ${lang} → ${PROFILE_NAME}: HTTP ${status}`,
        json?.key ?? json
      );
      const again = await api(
        "GET",
        `/qualityprofiles/search?organization=${ORG}&language=${lang}`
      );
      const againProfiles =
        again.json &&
        typeof again.json === "object" &&
        Array.isArray(again.json.profiles)
          ? again.json.profiles
          : [];
      profile = againProfiles.find((p) => p.name === PROFILE_NAME);
    }
    if (!profile) return;

    const prefix = lang === "ts" ? `${LANG_TS}:` : `${LANG_JS}:`;
    const noiseForLang = NOISE_RULES.filter((r) => r.startsWith(prefix));
    await deactivateRules(profile.key, noiseForLang);

    // Free plan may reject project association — try, report, continue.
    const assoc = await api("POST", "/qualityprofiles/add_project", {
      qualityProfile: PROFILE_NAME,
      language: lang,
      project: PROJECT,
      organization: ORG,
    });
    if (assoc.status === 200 || assoc.status === 204) {
      console.log(`  associated ${lang} profile with project`);
    } else {
      console.log(
        `  profile associate ${lang}: HTTP ${assoc.status} (expected on Free plan; multicriteria is the live control)`
      );
    }
  }, Promise.resolve());
}

/**
 * Deactivate a list of rules on a quality profile (sequential API calls).
 * @param {string} profileKey Profile key.
 * @param {string[]} rules Rule keys to deactivate.
 * @returns {Promise<void>}
 */
async function deactivateRules(profileKey, rules) {
  await rules.reduce(async (prev, rule) => {
    await prev;
    const { status } = await api("POST", "/qualityprofiles/deactivate_rule", {
      key: profileKey,
      rule,
    });
    if (status !== 200 && status !== 204) {
      console.warn(`    deactivate ${rule}: HTTP ${status}`);
    }
  }, Promise.resolve());
}

/**
 * Ensure the Centraid quality gate exists with the desired conditions.
 * @returns {Promise<void>}
 */
async function ensureGate() {
  const { json: list } = await api(
    "GET",
    `/qualitygates/list?organization=${ORG}`
  );
  const gates =
    list && typeof list === "object" && Array.isArray(list.qualitygates)
      ? list.qualitygates
      : [];
  let gate = gates.find((g) => g.name === GATE_NAME);
  if (gate) {
    console.log(`  gate ${GATE_NAME} exists (id=${gate.id})`);
  } else {
    const { status, json } = await api("POST", "/qualitygates/create", {
      name: GATE_NAME,
      organization: ORG,
    });
    console.log(`  create gate: HTTP ${status}`, json);
    const again = await api("GET", `/qualitygates/list?organization=${ORG}`);
    const againGates =
      again.json &&
      typeof again.json === "object" &&
      Array.isArray(again.json.qualitygates)
        ? again.json.qualitygates
        : [];
    gate = againGates.find((g) => g.name === GATE_NAME);
  }
  if (!gate) return;

  const { json: show } = await api(
    "GET",
    `/qualitygates/show?id=${gate.id}&organization=${ORG}`
  );
  const existing =
    show && typeof show === "object" && Array.isArray(show.conditions)
      ? show.conditions
      : [];
  const want = new Map(
    GATE_CONDITIONS.map((c) => [c.metric, `${c.op}:${c.error}`])
  );
  const have = new Map(existing.map((c) => [c.metric, `${c.op}:${c.error}`]));
  const matches =
    want.size === have.size &&
    [...want.entries()].every(([m, v]) => have.get(m) === v);
  if (matches) {
    console.log(`  conditions already match (${existing.length})`);
  } else {
    await existing.reduce(async (prev, c) => {
      await prev;
      const del = await api("POST", "/qualitygates/delete_condition", {
        id: c.id,
        organization: ORG,
      });
      if (del.status !== 200 && del.status !== 204) {
        console.warn(
          `  delete condition ${c.metric}: HTTP ${del.status}`,
          del.json
        );
      }
    }, Promise.resolve());
    await GATE_CONDITIONS.reduce(async (prev, c) => {
      await prev;
      const { status, json } = await api(
        "POST",
        "/qualitygates/create_condition",
        {
          gateId: gate.id,
          metric: c.metric,
          op: c.op,
          error: c.error,
          organization: ORG,
        }
      );
      console.log(`  condition ${c.metric}: HTTP ${status}`, json?.id ?? json);
    }, Promise.resolve());
  }

  const select = await api("POST", "/qualitygates/select", {
    gateId: gate.id,
    projectKey: PROJECT,
    organization: ORG,
  });
  if (select.status === 200 || select.status === 204) {
    console.log("  selected Centraid gate for project");
  } else {
    console.log(
      `  gate select: HTTP ${select.status} (expected on Free plan; Sonar way remains assigned)`
    );
  }
}

/**
 * Collect open issue keys for one rule (paginated).
 * @param {string} rule Rule key.
 * @param {number} [page] Page index (1-based).
 * @param {string[]} [acc] Accumulator.
 * @returns {Promise<string[]>} Issue keys.
 */
async function collectOpenIssueKeys(rule, page = 1, acc = []) {
  const { status, json } = await api(
    "GET",
    `/issues/search?componentKeys=${PROJECT}&branch=main&resolved=false&rules=${encodeURIComponent(rule)}&ps=500&p=${page}`
  );
  if (status !== 200) {
    console.warn(`  search ${rule}: HTTP ${status}`);
    return acc;
  }
  const issues =
    json && typeof json === "object" && Array.isArray(json.issues)
      ? json.issues
      : [];
  const next = acc.concat(issues.map((issue) => issue.key));
  const total =
    json && typeof json === "object" && typeof json.total === "number"
      ? json.total
      : 0;
  if (page * 500 >= total) return next;
  return collectOpenIssueKeys(rule, page + 1, next);
}

/**
 * Bulk-WONTFIX residual open issues on silenced noise rules.
 * @returns {Promise<void>}
 */
async function resolveNoise() {
  const total = await NOISE_RULES.reduce(async (prevTotalP, rule) => {
    const prevTotal = await prevTotalP;
    const keys = await collectOpenIssueKeys(rule);
    if (keys.length === 0) {
      console.log(`  ${rule}: 0 open`);
      return prevTotal;
    }
    const chunks = [];
    for (let i = 0; i < keys.length; i += BULK_CHUNK) {
      chunks.push(keys.slice(i, i + BULK_CHUNK));
    }
    const added = await chunks.reduce(async (prevN, chunk) => {
      const nSoFar = await prevN;
      const { status, json } = await api("POST", "/issues/bulk_change", {
        issues: chunk.join(","),
        do_transition: "wontfix",
        comment: RESOLVE_COMMENT,
      });
      const ok = status === 200 || status === 204;
      const n =
        ok &&
        json &&
        typeof json === "object" &&
        typeof json.success === "number"
          ? json.success
          : ok
            ? chunk.length
            : 0;
      console.log(
        `  ${rule}: chunk ${chunk.length} → HTTP ${status} success=${n}`
      );
      return nSoFar + n;
    }, Promise.resolve(0));
    return prevTotal + added;
  }, Promise.resolve(0));
  console.log(`  resolved ~${total} issues`);
}

/**
 * Print open-issue summary and active gate/profiles.
 * @returns {Promise<void>}
 */
async function summary() {
  const { json } = await api(
    "GET",
    `/issues/search?componentKeys=${PROJECT}&branch=main&resolved=false&ps=1&facets=types`
  );
  const openTotal =
    json && typeof json === "object" && typeof json.total === "number"
      ? json.total
      : "?";
  console.log(`  open issues on main: ${openTotal}`);
  const facets =
    json && typeof json === "object" && Array.isArray(json.facets)
      ? json.facets
      : [];
  for (const f of facets) {
    if (f.property === "types") {
      for (const v of f.values ?? []) {
        if (v.count) console.log(`    ${v.val}: ${v.count}`);
      }
    }
  }
  const { json: nav } = await api(
    "GET",
    `/navigation/component?component=${PROJECT}`
  );
  const gateName =
    nav &&
    typeof nav === "object" &&
    nav.qualityGate &&
    typeof nav.qualityGate === "object"
      ? nav.qualityGate.name
      : "?";
  console.log(`  quality gate: ${gateName ?? "?"}`);
  const profiles =
    nav && typeof nav === "object" && Array.isArray(nav.qualityProfiles)
      ? nav.qualityProfiles
          .filter((p) => p.language === "ts" || p.language === "js")
          .map((p) => `${p.language}=${p.name}`)
          .join(", ")
      : "";
  console.log(`  ts/js profiles: ${profiles || "?"}`);
}

async function main() {
  const resolve = process.argv.includes("--resolve-noise");
  console.log(`Configuring SonarCloud project ${PROJECT} (org ${ORG})…`);

  console.log("Analysis scope");
  await setMulti("sonar.exclusions", SOURCE_EXCLUSIONS);
  await setMulti("sonar.cpd.exclusions", CPD_EXCLUSIONS);
  await setMulti("sonar.coverage.exclusions", COVERAGE_EXCLUSIONS);
  await setMulti("sonar.test.inclusions", TEST_INCLUSIONS);

  console.log("Issue ignore multicriteria");
  await setMulticriteria();

  console.log("Quality profiles");
  await ensureProfiles();

  console.log("Quality gate");
  await ensureGate();

  if (resolve) {
    console.log("Resolve residual noise issues");
    await resolveNoise();
  }

  console.log("Summary");
  await summary();
  console.log(
    "Done. Next Autoscan on push/PR will honor scope + multicriteria."
  );
  console.log("See docs/toolchain.md#sonarcloud-autoscan");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
