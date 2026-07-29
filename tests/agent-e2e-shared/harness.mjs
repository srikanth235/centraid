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

/** JavaScript-lane counterpart of @centraid/test-kit's recordQualityResult. */
export async function recordQualityResult(repoRoot, result) {
  const directory = path.join(repoRoot, "artifacts", result.lane);
  const slug = result.owner
    .replaceAll(/[^a-z0-9]+/giu, "-")
    .replace(/^-|-$/gu, "");
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `${slug}.json`);
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
  const slug = owner.replaceAll(/[^a-z0-9]+/giu, "-").replace(/^-|-$/gu, "");
  try {
    const previous = JSON.parse(
      await fs.readFile(
        path.join(repoRoot, "artifacts", lane, `${slug}.json`),
        "utf8"
      )
    );
    const samples = (previous.history ?? [])
      .map((point) => Number(point.value))
      .filter((value) => Number.isFinite(value) && value >= 0)
      .slice(-10)
      .toSorted((left, right) => left - right);
    if (samples.length < 10) return null;
    return ((samples[4] + samples[5]) / 2) * 3;
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
    await fs.writeFile(
      path.join(evidenceDir, `${slug}.json`),
      `${JSON.stringify({ lane: "e2e", owner, name: slug, status: pass ? "passed" : "failed", capturedAt: new Date().toISOString(), measurements: [{ name: "wall clock", value: elapsedMs, unit: "ms" }] }, null, 2)}\n`
    );
  }
  console.log(`[runFlow] ${slug} ${pass ? "PASS" : "FAIL"} in ${elapsedMs}ms`);
  console.log(`  verdict : ${path.relative(repoRoot, verdict)}`);
  return pass;
}
