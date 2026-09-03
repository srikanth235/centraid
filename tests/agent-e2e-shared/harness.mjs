import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export function defaultRunId() {
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/gu, "-")
    .replace(/Z$/u, "");
  return `${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

export function evidencePlatform(env = process.env) {
  return String(env.MAESTRO_PLATFORM ?? "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "");
}

function evidenceSlug(owner) {
  const slug = owner.replaceAll(/[^a-z0-9]+/giu, "-").replace(/^-|-$/gu, "");
  const platform = evidencePlatform();
  return platform ? `${slug}-${platform}` : slug;
}

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

export async function qualityRegressionBudget(repoRoot, lane, owner) {
  return trailingMedianBudget(repoRoot, lane, owner, 10, 3);
}

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

async function trailingMedianBudget(
  repoRoot,
  lane,
  owner,
  minimumSamples,
  multiplier
) {
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
