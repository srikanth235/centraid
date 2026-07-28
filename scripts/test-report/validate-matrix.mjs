import { access, glob, readFile } from "node:fs/promises";
import path from "node:path";

import { detectDefaultCiEnvGate } from "./report-signals.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const allowedStatuses = new Set(["solid", "partial", "gap", "skip"]);
const boilerplatePartial =
  /has some owning proof but is incomplete or not continuously exercised/iu;
const nonStructuralSkip =
  /\b(?:no (?:dedicated )?(?:harness|rig|budget)|not (?:yet|currently)|\byet\b|planned)\b/iu;

export async function validateMatrix(matrix, options = {}) {
  const errors = [];
  const warnings = [];
  const dimensions = new Map(
    matrix.dimensions?.map((dimension) => [dimension.id, dimension])
  );
  const surfaces = new Map(
    matrix.surfaces?.map((surface) => [surface.id, surface])
  );
  const flowIds = new Set();
  const expectedCells = new Set();

  if (!dimensions.size) errors.push("matrix has no dimensions");
  if (!surfaces.size) errors.push("matrix has no surfaces");

  const notes = matrix.notes ?? {};

  const cellValidation = await Promise.all(
    [...surfaces.values()].flatMap((surface) =>
      [...dimensions.values()].map(async (dimension) => {
        const cellErrors = [];
        const cellId = `${surface.id}.${dimension.id}`;
        expectedCells.add(cellId);
        const status = surface.assessment?.[dimension.id];
        if (!allowedStatuses.has(status)) {
          cellErrors.push(
            `${surface.id}.${dimension.id} has invalid or missing assessment ${status}`
          );
        }
        const cellOwner = matrix.cellOwners?.[cellId];
        if (!(cellId in (matrix.cellOwners ?? {}))) {
          cellErrors.push(`${cellId} has no explicit cell-owner mapping`);
        } else if (status === "solid" || status === "partial") {
          if (
            !cellOwner ||
            typeof cellOwner.owner !== "string" ||
            !cellOwner.owner
          ) {
            cellErrors.push(`${cellId} is ${status} but has no owning test`);
          } else if (typeof cellOwner.tier !== "string" || !cellOwner.tier) {
            cellErrors.push(`${cellId} is ${status} but has no owning tier`);
          } else if (
            path.isAbsolute(cellOwner.owner) ||
            cellOwner.owner.includes("..")
          ) {
            cellErrors.push(
              `${cellId} owner must be a repository-relative path`
            );
          } else if (options.checkFiles !== false) {
            try {
              const ownerPath = path.join(
                options.root ?? root,
                cellOwner.owner
              );
              await access(ownerPath);
              // Solid/partial cells whose only owner is whole-file env-gated off
              // default CI claim coverage they never get on PR/nightly defaults.
              if (
                options.checkEnvGates !== false &&
                !cellOwner.owner.endsWith(".mjs")
              ) {
                try {
                  const source = await readFile(ownerPath, "utf8");
                  const gate = detectDefaultCiEnvGate(source);
                  if (gate) {
                    cellErrors.push(
                      `${cellId} is ${status} but owner ${cellOwner.owner} is always env-gated off default CI (${gate.env} / ${gate.kind}); demote assessment or ungated the suite`
                    );
                  }
                } catch {
                  // access already succeeded
                }
              }
            } catch {
              cellErrors.push(
                `${cellId} owner does not exist: ${cellOwner.owner}`
              );
            }
          }
        } else if (cellOwner !== null) {
          cellErrors.push(
            `${cellId} is ${status} and must map explicitly to null`
          );
        }
        // #535 Phase 5 — every skip cell must carry a reviewed one-line rationale
        // in matrix.notes so blanket amber skips cannot reappear without a note.
        if (status === "skip" && options.checkSkipNotes !== false) {
          const note = notes[cellId];
          if (typeof note !== "string" || !note.trim()) {
            cellErrors.push(
              `${cellId} is skip but has no matrix.notes rationale (add a one-line note or real owned coverage)`
            );
          }
          if (typeof note === "string" && nonStructuralSkip.test(note)) {
            cellErrors.push(
              `${cellId} is skip but its rationale describes missing work; use gap with a live tracking issue`
            );
          }
        }
        if (status === "gap") {
          const gap = matrix.gaps?.[cellId];
          const issue = gap?.trackingIssue;
          const issueRecord = matrix.trackingIssues?.[String(issue)];
          if (!Number.isInteger(issue) || issue < 1) {
            cellErrors.push(
              `${cellId} is gap but has no structured gaps.${cellId}.trackingIssue`
            );
          } else if (!issueRecord) {
            cellErrors.push(
              `${cellId} gap references unregistered tracking issue #${issue}`
            );
          } else if (issueRecord.state !== "open") {
            cellErrors.push(
              `${cellId} gap references closed tracking issue #${issue}`
            );
          }
        } else if (matrix.gaps?.[cellId]) {
          cellErrors.push(`${cellId} is not gap but has a gaps entry`);
        }
        if (status === "partial") {
          const note = notes[cellId];
          if (typeof note !== "string" || !note.trim()) {
            cellErrors.push(`${cellId} is partial but has no specific note`);
          } else if (boilerplatePartial.test(note)) {
            cellErrors.push(
              `${cellId} uses the rejected boilerplate partial note; name the missing proof`
            );
          }
        }
        if (
          status === "skip" &&
          /\bno .*migration/iu.test(notes[cellId] ?? "")
        ) {
          const trigger = matrix.revisitTriggers?.[cellId];
          if (!trigger?.glob || !Number.isInteger(trigger.trackingIssue)) {
            cellErrors.push(
              `${cellId} is a time-bound compat skip but has no checkable revisit trigger`
            );
          } else if (options.checkFiles !== false) {
            const matches = [];
            for await (const match of glob(trigger.glob, {
              cwd: options.root ?? root,
            })) {
              matches.push(match);
              if (matches.length > 1) break;
            }
            if (matches.length) {
              cellErrors.push(
                `${cellId} revisit trigger matched ${matches[0]}; convert the skip to a tracked gap`
              );
            }
          }
        }
        return cellErrors;
      })
    )
  );
  errors.push(...cellValidation.flat());

  for (const surface of surfaces.values()) {
    for (const assessment of Object.keys(surface.assessment ?? {})) {
      if (!dimensions.has(assessment))
        errors.push(`${surface.id} references unknown dimension ${assessment}`);
    }
  }

  for (const cellId of Object.keys(matrix.cellOwners ?? {})) {
    if (!expectedCells.has(cellId))
      errors.push(`unknown cell-owner mapping ${cellId}`);
  }

  const flowValidation = await Promise.all(
    (matrix.flows ?? []).map(async (flow) => {
      const flowErrors = [];
      const flowWarnings = [];
      if (flowIds.has(flow.id)) flowErrors.push(`duplicate flow id ${flow.id}`);
      flowIds.add(flow.id);
      if (!surfaces.has(flow.surface))
        flowErrors.push(
          `${flow.id} references unknown surface ${flow.surface}`
        );
      if (!dimensions.has(flow.dimension)) {
        flowErrors.push(
          `${flow.id} references unknown dimension ${flow.dimension}`
        );
      }
      if (typeof flow.owner !== "string" || !flow.owner) {
        flowErrors.push(`${flow.id} must have exactly one owning file`);
        return { errors: flowErrors, warnings: flowWarnings };
      }
      if (path.isAbsolute(flow.owner) || flow.owner.includes("..")) {
        flowErrors.push(`${flow.id} owner must be a repository-relative path`);
        return { errors: flowErrors, warnings: flowWarnings };
      }
      // #545 D4 — warn on missing minimumTests even when file checks are off.
      if (
        options.warnMissingMinimumTests &&
        flow.minimumTests === undefined &&
        flow.tier !== "perf" &&
        flow.tier !== "scale" &&
        flow.tier !== "e2e"
      ) {
        flowWarnings.push(
          `${flow.id} has no minimumTests (set a floor or minimumTests: null for perf/scale/e2e opt-out)`
        );
      }
      if (options.checkFiles !== false) {
        try {
          const ownerPath = path.join(options.root ?? root, flow.owner);
          await access(ownerPath);
          const source = await readFile(ownerPath, "utf8");
          if (flow.minimumTests !== undefined && flow.minimumTests !== null) {
            const testCount = source.match(/\b(?:test|it)\s*\(/gu)?.length ?? 0;
            if (testCount < flow.minimumTests) {
              flowErrors.push(
                `${flow.id} contract shrank: ${testCount} tests, minimum ${flow.minimumTests}`
              );
            }
          }
          // #496 B2 — env-gated *flow* owners cannot claim solid/partial cells
          // without evidence that the gate runs in the default lane.
          if (options.checkEnvGates !== false && !flow.owner.endsWith(".mjs")) {
            const gate = detectDefaultCiEnvGate(source);
            if (gate) {
              const cellId = `${flow.surface}.${flow.dimension}`;
              const surface = surfaces.get(flow.surface);
              const status = surface?.assessment?.[flow.dimension];
              if (status === "solid" || status === "partial") {
                flowErrors.push(
                  `flow ${flow.id} owner ${flow.owner} is env-gated off default CI (${gate.env} / ${gate.kind}) while cell ${cellId} is ${status}; demote assessment, ungated the suite, or mark the flow skip`
                );
              }
            }
          }
        } catch {
          flowErrors.push(`${flow.id} owner does not exist: ${flow.owner}`);
        }
      }
      return { errors: flowErrors, warnings: flowWarnings };
    })
  );
  errors.push(...flowValidation.flatMap((result) => result.errors));
  warnings.push(...flowValidation.flatMap((result) => result.warnings));

  if (
    options.checkWorkspaceCompleteness !== false &&
    options.checkFiles !== false
  ) {
    const packageJson = JSON.parse(
      await readFile(path.join(options.root ?? root, "package.json"), "utf8")
    );
    const patterns = packageJson.workspaces?.packages ?? [];
    const workspacePaths = (
      await Promise.all(
        patterns.map((pattern) =>
          Array.fromAsync(
            glob(`${pattern}/package.json`, {
              cwd: options.root ?? root,
            })
          )
        )
      )
    )
      .flat()
      .map((manifestPath) =>
        path.posix.dirname(manifestPath.replaceAll("\\", "/"))
      );
    for (const workspacePath of workspacePaths.sort()) {
      const mappedSurface = matrix.workspaceSurfaces?.[workspacePath];
      if (!mappedSurface) {
        errors.push(
          `workspace ${workspacePath} has no matrix surface mapping in workspaceSurfaces`
        );
      } else if (!surfaces.has(mappedSurface)) {
        errors.push(
          `workspace ${workspacePath} maps to unknown matrix surface ${mappedSurface}`
        );
      }
    }
  }

  return { errors, warnings, dimensions, surfaces, flowIds };
}

async function main() {
  const matrixPath = path.resolve(
    process.argv[2] ?? path.join(root, "tests/matrix.json")
  );
  const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
  const { errors, warnings, surfaces, dimensions, flowIds } =
    await validateMatrix(matrix, {
      warnMissingMinimumTests: true,
    });
  for (const w of warnings ?? []) console.warn(`matrix: warning: ${w}`);
  if (errors.length) {
    for (const error of errors) console.error(`matrix: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `matrix: ${surfaces.size} surfaces × ${dimensions.size} dimensions, ${flowIds.size} canonical flows`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  await main();
}
