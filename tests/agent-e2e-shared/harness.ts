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
export interface FlowResult {
  pass?: boolean;
  notes?: string;
}

export interface FlowVerdictInput {
  repoRoot: string;
  slug: string;
  runDir: string;
  elapsedMs: number;
  error?: unknown;
  notes: readonly string[];
  result?: FlowResult | null;
  metadata?: Record<string, unknown>;
  debug?: string;
  owner?: string;
}

export function evidencePlatform(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.MAESTRO_PLATFORM ?? "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "");
}

/** `<owner-slug>` filename stem, platform-suffixed when MAESTRO_PLATFORM is set. */
function evidenceSlug(owner: string): string {
  const slug = owner.replaceAll(/[^a-z0-9]+/giu, "-").replace(/^-|-$/gu, "");
  const platform = evidencePlatform();
  return platform ? `${slug}-${platform}` : slug;
}

export interface QualityMeasurement {
  name: string;
  value: number;
  unit?: string;
  budget?: number;
}

export interface QualityResult {
  lane: string;
  owner: string;
  measurements: QualityMeasurement[];
  [field: string]: unknown;
}

export interface QualityHistoryPoint {
  at: string;
  value: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function historyFromFile(raw: string): QualityHistoryPoint[] {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !Array.isArray(parsed.history)) return [];
  return parsed.history.filter((entry): entry is QualityHistoryPoint => {
    return (
      isRecord(entry) &&
      typeof entry.at === "string" &&
      typeof entry.value === "number"
    );
  });
}

/** JavaScript-lane counterpart of @centraid/test-kit's recordQualityResult. */
export async function recordQualityResult(
  repoRoot: string,
  result: QualityResult
): Promise<void> {
  const directory = path.join(repoRoot, "artifacts", result.lane);
  await fs.mkdir(directory, { recursive: true });
  const platform = evidencePlatform();
  const file = path.join(directory, `${evidenceSlug(result.owner)}.json`);
  let history: QualityHistoryPoint[] = [];
  try {
    history = historyFromFile(await fs.readFile(file, "utf8"));
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
}: FlowVerdictInput): Promise<boolean> {
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
    const stack =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    lines.push("## Error", "```", stack, "```", "");
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
