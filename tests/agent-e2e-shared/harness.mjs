import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/** Shared run identity used by the desktop, mobile and pairing manual-QA adapters. */
export function defaultRunId() {
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/gu, "-")
    .replace(/Z$/u, "");
  return `${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

/**
 * Platform segment for evidence keys (#781, QUALITY.md "keyed by flow, not
 * flow × platform"). The mobile jobs export `MAESTRO_PLATFORM=ios|android`;
 * suffixing the artifact filename with it stops the iOS and Android uploads
 * of the same flow from last-write-winning over each other after the report
 * job's `merge-multiple` download. Platform-less lanes (pairing, desktop,
 * web) see an empty segment and keep their exact current paths.
 */
export function evidencePlatform(env = process.env) {
  return String(env.MAESTRO_PLATFORM ?? "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "");
}

/** `<owner-slug>` filename stem, platform-suffixed when MAESTRO_PLATFORM is set. */
function evidenceSlug(owner) {
  const slug = owner.replaceAll(/[^a-z0-9]+/giu, "-").replace(/^-|-$/gu, "");
  const platform = evidencePlatform();
  return platform ? `${slug}-${platform}` : slug;
}

/** JavaScript-lane counterpart of @centraid/test-kit's recordQualityResult. */
export async function recordQualityResult(repoRoot, result) {
  const directory = path.join(repoRoot, "artifacts", result.lane);
  await fs.mkdir(directory, { recursive: true });
  const platform = evidencePlatform();
  const file = path.join(directory, `${evidenceSlug(result.owner)}.json`);
  let history = [];
  try {
    history = JSON.parse(await fs.readFile(file, "utf8")).history ?? [];
  } catch {
    history = [];
  }
  const capturedAt = new Date().toISOString();
  await fs.writeFile(
    file,
    `${JSON.stringify(
      {
        ...result,
        ...(platform ? { platform } : {}),
        capturedAt,
        history: [
          ...history,
          {
            at: capturedAt,
            value: result.measurements[0]?.value ?? 0,
          },
        ].slice(-30),
      },
      null,
      2
    )}\n`
  );
}

/** Activate the 3× trailing-median budget only after ten durable samples. */
export async function qualityRegressionBudget(repoRoot, lane, owner) {
  return trailingMedianBudget(repoRoot, lane, owner, 10, 3);
}

/**
 * Sustained-drift budget (#659 R4) — the JavaScript-lane counterpart of
 * `rigDriftBudgetMs` in tests/helpers/rig-budgets.ts. Knobs come from
 * tests/journeys.json#rigs rather than being repeated here, so the
 * on-device flows and the vitest rigs cannot drift apart on what "drift" means.
 */
export async function rigDriftBudget(repoRoot, lane, owner) {
  const registry = JSON.parse(
    await fs.readFile(path.join(repoRoot, "tests/budgets.json"), "utf8")
  ).qualityRigs;
  return trailingMedianBudget(
    repoRoot,
    lane,
    owner,
    registry.minimumDriftSamples,
    registry.driftMultiplier
  );
}

/**
 * Shared trailing-median arithmetic. Returns null until `minimumSamples`
 * durable observations exist — a null is "no opinion yet", never a pass.
 */
async function trailingMedianBudget(
  repoRoot,
  lane,
  owner,
  minimumSamples,
  multiplier
) {
  // Same platform-keyed path recordQualityResult writes, so an iOS budget is
  // computed over iOS samples only — cross-platform samples never interleave
  // into a false ratchet (#781, QUALITY.md).
  try {
    const previous = JSON.parse(
      await fs.readFile(
        path.join(repoRoot, "artifacts", lane, `${evidenceSlug(owner)}.json`),
        "utf8"
      )
    );
    const samples = (previous.history ?? [])
      .map((point) => Number(point.value))
      .filter((value) => Number.isFinite(value) && value >= 0)
      .slice(-minimumSamples)
      .toSorted((left, right) => left - right);
    if (samples.length < minimumSamples) return null;
    const middle = Math.floor(samples.length / 2);
    const median =
      samples.length % 2
        ? samples[middle]
        : (samples[middle - 1] + samples[middle]) / 2;
    return median * multiplier;
  } catch {
    return null;
  }
}

/**
 * One verdict contract for every agent-driven exploratory surface. Platform
 * adapters own setup/teardown, but run metadata, notes, failures and result
 * summaries are deliberately identical and machine-greppable.
 */
export async function writeFlowVerdict({
  repoRoot,
  slug,
  runDir,
  elapsedMs,
  error,
  notes,
  result,
  metadata = {},
  debug,
  owner,
}) {
  const pass = !error && result?.pass !== false;
  const lines = [
    `# ${slug}`,
    "",
    `**${pass ? "PASS" : "FAIL"}** — ${elapsedMs}ms`,
    "",
  ];
  for (const [label, value] of Object.entries({
    "run dir": runDir,
    ...metadata,
  })) {
    lines.push(`- ${label}: \`${value}\``);
  }
  lines.push("");
  if (error) {
    lines.push("## Error", "```", error.stack ?? String(error), "```", "");
    if (debug) lines.push("## Debug", "", debug, "");
  }
  if (notes.length) {
    lines.push("## Notes");
    for (const note of notes) lines.push(`- ${note}`);
    lines.push("");
  }
  if (result?.notes) lines.push("## Result", String(result.notes), "");
  const verdict = path.join(runDir, "verdict.md");
  await fs.writeFile(verdict, lines.join("\n"));
  if (owner) {
    const evidenceDir = path.join(repoRoot, "artifacts", "e2e");
    await fs.mkdir(evidenceDir, { recursive: true });
    // Platform-keyed filename (#781): iOS and Android runs of the same flow
    // must not overwrite each other in the merged nightly evidence tree. The
    // owner INSIDE the JSON stays the flow file, so matrix mapping is
    // unchanged and the report's worst-status merge sees both platforms.
    const platform = evidencePlatform();
    await fs.writeFile(
      path.join(evidenceDir, `${platform ? `${slug}-${platform}` : slug}.json`),
      `${JSON.stringify({ lane: "e2e", owner, name: slug, status: pass ? "passed" : "failed", ...(platform ? { platform } : {}), capturedAt: new Date().toISOString(), measurements: [{ name: "wall clock", value: elapsedMs, unit: "ms" }] }, null, 2)}\n`
    );
  }
  console.log(`[runFlow] ${slug} ${pass ? "PASS" : "FAIL"} in ${elapsedMs}ms`);
  console.log(`  verdict : ${path.relative(repoRoot, verdict)}`);
  return pass;
}
