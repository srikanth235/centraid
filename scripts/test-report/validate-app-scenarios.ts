import { access } from "node:fs/promises";
import path from "node:path";

import { bags, dict, isRecord, text } from "./record.ts";
import type { Loose } from "./record.ts";

const LAYER_IDS = ["unit", "component", "journey"];
const STATUSES = new Set(["owned", "gap", "product-bug", "held", "skip"]);

async function fileExists(cwd: string, target: string) {
  try {
    await access(path.join(cwd, target));
    return true;
  } catch {
    return false;
  }
}

/**
 * #864 Wave 7 — the per-app scenario ledger. Closed against the bundled apps
 * the same way grids B and D are: an absence is a validation error, a gap
 * cites an open issue, an owned row names a repository-relative owner that
 * exists on disk, and a product-bug is a declared defect with a note so it
 * cannot hide as a missing test.
 *
 * @param {object} matrix Parsed test matrix.
 * @param {{ root: string, checkFiles?: boolean }} options Validator options; `root` is the repo root.
 * @param {{ expectedApps: string[]|null, openIssue: (n: string|number) => boolean, issues: Loose }} ctx Bundled-app axis, open-issue predicate, and trackingIssues map.
 * @returns {Promise<string[]>} Validation error strings; empty when the ledger is well-formed.
 */
export async function validateAppScenarios(
  matrix: Loose,
  options: { root: string; checkFiles?: boolean },
  ctx: {
    expectedApps: string[] | null;
    openIssue: (n: string | number) => boolean;
    issues: Loose;
  }
): Promise<string[]> {
  const errors: string[] = [];
  const cwd = options.root;
  const checkFiles = options.checkFiles !== false;
  const { expectedApps, openIssue, issues } = ctx;
  const deferred: Array<Promise<string | null>> = [];

  function requirePath(target: string, message: string) {
    if (!checkFiles) return;
    deferred.push(
      fileExists(cwd, target).then((found) =>
        found ? null : `${message}: ${target}`
      )
    );
  }

  const block = matrix.appScenarios;
  if (!isRecord(block)) {
    errors.push("matrix has no appScenarios ledger");
    return errors;
  }
  if (!openIssue(String(block.trackingIssue ?? ""))) {
    errors.push(
      `appScenarios gaps cite no open tracking issue (#${block.trackingIssue ?? "none"})`
    );
  }
  const layers = bags(block.layers);
  const layerIds = layers.map((layer) => layer.id);
  if (JSON.stringify(layerIds) !== JSON.stringify(LAYER_IDS)) {
    errors.push(
      `appScenarios layers must be exactly ${LAYER_IDS.join(", ")}; got ${layerIds.join(", ") || "(none)"}`
    );
  }
  for (const layer of layers) {
    if (!text(layer.label).trim()) {
      errors.push(`appScenarios layer ${layer.id ?? "(missing)"} has no label`);
    }
  }

  if (!Array.isArray(block.apps)) {
    errors.push("appScenarios has no apps array");
    return [
      ...errors,
      ...(await Promise.all(deferred)).filter(
        (error): error is string => typeof error === "string"
      ),
    ];
  }

  const declared = new Set();
  for (const app of bags(block.apps)) {
    if (!app.id || declared.has(app.id)) {
      errors.push(
        `appScenarios app id missing or duplicated: ${app.id ?? "(missing)"}`
      );
    }
    declared.add(app.id);
    const label = `appScenarios ${app.id ?? "(missing)"}`;
    if (typeof app.doc !== "string" || !app.doc) {
      errors.push(`${label} names no scenario doc`);
    } else if (path.isAbsolute(app.doc) || app.doc.includes("..")) {
      errors.push(`${label} doc must be a repository-relative path`);
    } else {
      requirePath(app.doc, `${label} doc does not exist`);
    }
    if (!Array.isArray(app.scenarios) || !app.scenarios.length) {
      errors.push(`${label} declares no scenarios`);
      continue;
    }
    const ids = new Set();
    for (const raw of bags(app.scenarios)) {
      const scenario = dict(raw);
      const row = `${label}.${scenario.id ?? "(missing)"}`;
      if (!scenario.id || ids.has(scenario.id)) {
        errors.push(`${row} id missing or duplicated`);
      }
      ids.add(scenario.id);
      if (!text(scenario.label).trim()) errors.push(`${row} has no label`);
      if (!LAYER_IDS.includes(String(scenario.layer))) {
        errors.push(
          `${row} layer must be one of ${LAYER_IDS.join(", ")}; got ${scenario.layer ?? "(none)"}`
        );
      }
      if (!STATUSES.has(String(scenario.status))) {
        errors.push(`${row} has invalid status ${scenario.status ?? "(none)"}`);
        continue;
      }
      if (scenario.status === "owned") {
        if (typeof scenario.owner !== "string" || !scenario.owner) {
          errors.push(`${row} is owned but has no owning proof`);
        } else if (
          path.isAbsolute(scenario.owner) ||
          scenario.owner.includes("..")
        ) {
          errors.push(`${row} owner must be a repository-relative path`);
        } else {
          requirePath(scenario.owner, `${row} owner does not exist`);
        }
      } else if (scenario.status === "gap") {
        const issue = scenario.trackingIssue ?? block.trackingIssue;
        if (!openIssue(String(issue ?? ""))) {
          errors.push(
            `${row} is gap but cites no open tracking issue (#${issue ?? "none"})`
          );
        }
      } else if (scenario.status === "product-bug") {
        const issue = scenario.trackingIssue ?? block.trackingIssue;
        if (!openIssue(String(issue ?? ""))) {
          errors.push(
            `${row} is product-bug but cites no open tracking issue (#${issue ?? "none"})`
          );
        }
        if (!text(scenario.note).trim()) {
          errors.push(
            `${row} is product-bug but has no note naming the defect`
          );
        }
      } else if (scenario.status === "held") {
        const citation = String(scenario.citation ?? "");
        const issueRef = /^#(?<issue>\d+)$/u.exec(citation);
        if (!issueRef) {
          errors.push(
            `${row} is held but cites no issue; use the ruling that held it, e.g. #831 (got ${citation || "none"})`
          );
        } else if (!issues[issueRef.groups?.issue ?? ""]) {
          errors.push(
            `${row} held cites unregistered issue ${citation}; add it to trackingIssues`
          );
        }
      } else if (scenario.status === "skip") {
        if (!text(scenario.reason).trim()) {
          errors.push(`${row} skip has no structural reason`);
        }
        const citation = String(scenario.citation ?? "");
        const issueRef = /^#(?<issue>\d+)$/u.exec(citation);
        if (issueRef) {
          if (!issues[issueRef.groups?.issue ?? ""]) {
            errors.push(
              `${row} skip cites unregistered issue ${citation}; add it to trackingIssues`
            );
          }
        } else if (!citation.includes("#") && !citation.includes(".md")) {
          errors.push(`${row} skip has no followable citation`);
        }
      }
    }
  }

  if (expectedApps) {
    const actual = [...declared].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expectedApps)) {
      errors.push(
        `appScenarios app registry must exactly match bundled apps: expected ${expectedApps.join(", ")}; got ${actual.join(", ") || "(none)"}`
      );
    }
  }

  errors.push(
    ...(await Promise.all(deferred)).filter(
      (error): error is string => typeof error === "string"
    )
  );
  return errors;
}
