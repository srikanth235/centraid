import { access, glob, readFile } from "node:fs/promises";
import path from "node:path";

import { MUTATION_SEEDS } from "../mutation/seeds.mjs";
import { countDeclaredTests, gradeMatrix } from "./matrix-grades.mjs";
import { detectDefaultCiEnvGate } from "./report-signals.mjs";
import { discoverSkipSites, validateSkipInventory } from "./skip-inventory.mjs";

const root = path.resolve(import.meta.dirname, "../..");
/**
 * The three client seats (docs/blueprint-seats.md). A seat is WHERE bytes live
 * and which way they flow — orthogonal to form factor — so the set is closed
 * by product doctrine, not by what happens to be built.
 */
export const SEAT_IDS = ["origin", "custodian", "viewer"];
const allowedStatuses = new Set(["solid", "partial", "gap", "skip"]);
const boilerplatePartial =
  /has some owning proof but is incomplete or not continuously exercised/iu;
const nonStructuralSkip =
  /\b(?:no (?:dedicated )?(?:harness|rig|budget)|not (?:yet|currently)|\byet\b|planned)\b/iu;

/**
 * Evaluate one compat revisit trigger. Returns the first file that proves the
 * skip is stale, an error when the glob can no longer match anything (a
 * tripwire pointing at a path that does not exist is worse than no tripwire),
 * or neither when the surface is still genuinely migration-free.
 */
export async function fireRevisitTrigger(trigger, { cwd, readSource } = {}) {
  const read =
    readSource ??
    ((file) => readFile(path.join(cwd, file), "utf8").catch(() => null));
  const candidates = [];
  for await (const match of glob(trigger.glob, { cwd })) {
    const file = match.replaceAll("\\", "/");
    if (/\.(?:test|spec)\.[a-z]+$/u.test(file)) continue;
    candidates.push(file);
  }
  if (!candidates.length) {
    return {
      error: `glob ${trigger.glob} matches no file; point it at a path that exists so the tripwire can fire`,
    };
  }
  if (!trigger.contains) return { match: candidates.sort()[0] };
  let pattern;
  try {
    pattern = new RegExp(trigger.contains, "u");
  } catch {
    return { error: `contains is not a valid regex: ${trigger.contains}` };
  }
  const sorted = candidates.sort();
  const sources = await Promise.all(sorted.map((file) => read(file)));
  const hit = sorted.findIndex(
    (_, index) =>
      typeof sources[index] === "string" && pattern.test(sources[index])
  );
  return hit === -1 ? {} : { match: sorted[hit] };
}

/** GitHub-style heading slug, so a `file.md#anchor` citation is checkable. */
function headingSlug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}\s-]/gu, "")
    .replaceAll(/\s+/gu, "-");
}

/** Every heading anchor a markdown document actually offers. */
async function documentAnchors(cwd, docPath) {
  const source = await readFile(path.join(cwd, docPath), "utf8");
  return new Set(
    [...source.matchAll(/^#{1,6}\s+(?<heading>.+?)\s*$/gmu)].map((match) =>
      headingSlug(match.groups.heading)
    )
  );
}

/** The bundled blueprint ids on disk — the one authority for every app axis. */
async function bundledAppIds(cwd) {
  const ids = [];
  for await (const manifest of glob("packages/blueprints/apps/*/app.json", {
    cwd,
  })) {
    ids.push(path.posix.basename(path.posix.dirname(manifest)));
  }
  return ids.filter((id) => !id.startsWith("_")).sort();
}

/** True when `target` exists under `cwd`. */
async function fileExists(cwd, target) {
  try {
    await access(path.join(cwd, target));
    return true;
  } catch {
    return false;
  }
}

/**
 * #839 Wave 0 (gaps G6, G7, G16) — the app-shaped axes: `seats`, `appSeats`
 * (grid B), `appStates` (grid D), the full `engineRegistry`, and the
 * `consentLedger`. Every one of them is TOTAL AND CLOSED in the same sense as
 * `appEngines`: the app axis must equal what is on disk, every app owes a cell
 * for every seat and every designed state, and the state partition must MIRROR
 * that app's own `app.json#states` block. An absence is a validation error, so
 * "we forgot" cannot render as "not applicable".
 */
async function validateAppAxes(matrix, options, flowIds) {
  const errors = [];
  const cwd = options.root ?? root;
  const checkFiles = options.checkFiles !== false;
  const issues = matrix.trackingIssues ?? {};
  const openIssue = (issue) => issues[String(issue)]?.state === "open";

  const seats = Array.isArray(matrix.seats) ? matrix.seats : null;
  const seatIds = seats?.map((seat) => seat?.id) ?? [];
  if (!seats) {
    errors.push("matrix has no seats registry");
  } else {
    if (
      JSON.stringify([...seatIds].sort()) !==
      JSON.stringify([...SEAT_IDS].sort())
    ) {
      errors.push(
        `matrix seats must be exactly ${SEAT_IDS.join(", ")}; got ${seatIds.join(", ") || "(none)"}`
      );
    }
    for (const seat of seats) {
      if (!seat?.label?.trim())
        errors.push(`seat ${seat?.id ?? "(missing)"} has no label`);
      if (!seat?.doctrine?.trim())
        errors.push(`seat ${seat?.id ?? "(missing)"} has no doctrine citation`);
    }
  }

  // One anchor cache: a citation that points at a heading the doc does not
  // have reads as doctrine while protecting nothing.
  const anchorCache = new Map();
  async function citationError(citation, label) {
    const [docPath, anchor] = String(citation ?? "").split("#");
    if (!docPath || !anchor) return `${label} citation is not a doc#anchor`;
    if (!checkFiles) return null;
    if (!anchorCache.has(docPath)) {
      anchorCache.set(
        docPath,
        await documentAnchors(cwd, docPath).catch(() => null)
      );
    }
    const anchors = anchorCache.get(docPath);
    if (!anchors)
      return `${label} citation document does not exist: ${docPath}`;
    return anchors.has(anchor)
      ? null
      : `${label} citation anchor does not exist: ${citation}`;
  }
  for (const seat of seats ?? []) {
    const error = await citationError(seat?.doctrine, `seat ${seat?.id}`);
    if (error) errors.push(error);
  }

  const expectedApps = checkFiles ? await bundledAppIds(cwd) : null;
  /** The app axis of a grid must equal the bundled apps, in any order. */
  function checkAppAxis(block, declared) {
    if (!expectedApps) return;
    const actual = [...declared].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expectedApps))
      errors.push(
        `${block} app registry must exactly match bundled apps: expected ${expectedApps.join(", ")}; got ${actual.join(", ") || "(none)"}`
      );
  }

  // ---- Grid B: app × seat -------------------------------------------------
  const appSeats = matrix.appSeats;
  if (!appSeats || !Array.isArray(appSeats.apps)) {
    errors.push("matrix has no appSeats grid");
  } else {
    const declared = new Set();
    for (const app of appSeats.apps) {
      if (!app?.id || declared.has(app.id))
        errors.push(
          `appSeats app id missing or duplicated: ${app?.id ?? "(missing)"}`
        );
      declared.add(app?.id);
      for (const seatId of SEAT_IDS) {
        const cell = app?.seats?.[seatId];
        const label = `appSeats ${app?.id}.${seatId}`;
        if (!cell) {
          errors.push(`${label} is missing`);
          continue;
        }
        if (cell.status === "owned") {
          if (typeof cell.owner !== "string" || !cell.owner)
            errors.push(`${label} is owned but has no owning journey`);
          else if (path.isAbsolute(cell.owner) || cell.owner.includes(".."))
            errors.push(`${label} owner must be a repository-relative path`);
          else if (checkFiles && !(await fileExists(cwd, cell.owner)))
            errors.push(`${label} owner does not exist: ${cell.owner}`);
          if (typeof cell.tier !== "string" || !cell.tier)
            errors.push(`${label} is owned but has no owning tier`);
        } else if (cell.status === "gap") {
          if (!openIssue(cell.trackingIssue))
            errors.push(
              `${label} is gap but cites no open tracking issue (#${cell.trackingIssue ?? "none"})`
            );
        } else if (cell.status === "skip") {
          if (!cell.reason?.trim())
            errors.push(`${label} skip has no structural reason`);
          const citation = String(cell.citation ?? "");
          const issueRef = /^#(?<issue>\d+)$/u.exec(citation);
          if (issueRef) {
            // A held interface cites the RULING that held it; that issue is
            // closed once the clearing landed, so state is not checked here —
            // only that the reference is a registered, followable one.
            if (!issues[issueRef.groups.issue])
              errors.push(
                `${label} skip cites unregistered issue ${citation}; add it to trackingIssues`
              );
          } else {
            const error = await citationError(citation, `${label} skip`);
            if (error) errors.push(error);
          }
        } else {
          errors.push(`${label} has invalid status ${cell.status}`);
        }
      }
      for (const seatId of Object.keys(app?.seats ?? {}))
        if (!SEAT_IDS.includes(seatId))
          errors.push(`appSeats ${app.id} references unknown seat ${seatId}`);
    }
    checkAppAxis("appSeats", declared);
  }

  // ---- Grid D: app × designed state ---------------------------------------
  const appStates = matrix.appStates;
  if (!appStates || !Array.isArray(appStates.apps)) {
    errors.push("matrix has no appStates grid");
  } else {
    if (!openIssue(appStates.trackingIssue))
      errors.push(
        `appStates gaps cite no open tracking issue (#${appStates.trackingIssue ?? "none"})`
      );
    const stateIds = (appStates.states ?? []).map((state) => state?.id);
    if (!stateIds.length) errors.push("appStates declares no designed states");
    if (new Set(stateIds).size !== stateIds.length)
      errors.push("appStates declares a duplicated designed state");
    for (const state of appStates.states ?? [])
      if (!state?.label?.trim())
        errors.push(`appStates state ${state?.id ?? "(missing)"} has no label`);
    const declared = new Set();
    for (const app of appStates.apps) {
      if (!app?.id || declared.has(app.id))
        errors.push(
          `appStates app id missing or duplicated: ${app?.id ?? "(missing)"}`
        );
      declared.add(app?.id);
      // The manifest is the design's own word on which states this app owes;
      // the grid may not disagree with it, in either direction.
      let manifestStates = null;
      if (checkFiles) {
        const manifestPath = `packages/blueprints/apps/${app?.id}/app.json`;
        try {
          manifestStates = JSON.parse(
            await readFile(path.join(cwd, manifestPath), "utf8")
          ).states;
        } catch {
          errors.push(
            `appStates ${app?.id} has no manifest at ${manifestPath}`
          );
        }
        if (
          manifestStates &&
          (!Array.isArray(manifestStates.designed) ||
            !Array.isArray(manifestStates.excluded))
        ) {
          errors.push(`appStates ${app?.id} manifest declares no states block`);
          manifestStates = null;
        }
      }
      const designed = new Set(manifestStates?.designed ?? []);
      const excluded = new Set(
        (manifestStates?.excluded ?? []).map((entry) => entry?.state ?? entry)
      );
      if (manifestStates) {
        const partition = [...designed, ...excluded].sort();
        if (JSON.stringify(partition) !== JSON.stringify([...stateIds].sort()))
          errors.push(
            `appStates ${app.id} must cover exactly its manifest partition: expected ${partition.join(", ")}; grid declares ${[...stateIds].sort().join(", ")}`
          );
      }
      for (const stateId of stateIds) {
        const cell = app?.states?.[stateId];
        const label = `appStates ${app?.id}.${stateId}`;
        if (!cell) {
          errors.push(`${label} is missing`);
          continue;
        }
        if (cell.status === "owned") {
          if (typeof cell.owner !== "string" || !cell.owner)
            errors.push(`${label} is owned but has no owning proof`);
          else if (path.isAbsolute(cell.owner) || cell.owner.includes(".."))
            errors.push(`${label} owner must be a repository-relative path`);
          else if (checkFiles && !(await fileExists(cwd, cell.owner)))
            errors.push(`${label} owner does not exist: ${cell.owner}`);
        } else if (cell.status !== "gap" && cell.status !== "excluded") {
          errors.push(`${label} has invalid status ${cell.status}`);
        }
        if (!manifestStates) continue;
        if (excluded.has(stateId) && cell.status !== "excluded")
          errors.push(
            `${label} is ${cell.status} but the app manifest excludes that state; mirror app.json#states`
          );
        if (designed.has(stateId) && cell.status === "excluded")
          errors.push(
            `${label} is excluded but the app manifest designs that state; mirror app.json#states`
          );
      }
      for (const stateId of Object.keys(app?.states ?? {}))
        if (!stateIds.includes(stateId))
          errors.push(
            `appStates ${app.id} references undeclared state ${stateId}`
          );
    }
    checkAppAxis("appStates", declared);
  }

  // ---- The 19-engine registry ---------------------------------------------
  const registry = matrix.engineRegistry;
  const seedIds = new Set(MUTATION_SEEDS.map((seed) => seed.id));
  if (!Array.isArray(registry) || !registry.length) {
    errors.push("matrix has no engineRegistry");
  } else {
    const ids = new Set();
    for (const engine of registry) {
      const label = `engineRegistry ${engine?.id ?? "(missing)"}`;
      if (!engine?.id || ids.has(engine.id))
        errors.push(
          `engineRegistry id missing or duplicated: ${engine?.id ?? "(missing)"}`
        );
      ids.add(engine?.id);
      if (!engine?.label?.trim()) errors.push(`${label} has no label`);
      if (!Array.isArray(engine?.source) || !engine.source.length)
        errors.push(`${label} names no source`);
      for (const source of engine?.source ?? []) {
        if (
          typeof source !== "string" ||
          path.isAbsolute(source) ||
          source.includes("..")
        )
          errors.push(`${label} source must be a repository-relative path`);
        else if (checkFiles && !(await fileExists(cwd, source)))
          errors.push(`${label} source does not exist: ${source}`);
      }
      if (engine?.propertyFlow != null && !flowIds.has(engine.propertyFlow))
        errors.push(
          `${label} references unknown property flow ${engine.propertyFlow}`
        );
      if (engine?.mutationSeed != null && !seedIds.has(engine.mutationSeed))
        errors.push(
          `${label} references unknown mutation seed ${engine.mutationSeed}`
        );
      if (typeof engine?.appEngineColumn !== "boolean")
        errors.push(`${label} does not say whether it is an appEngines column`);
    }
    // The two registries are one fact seen twice: every engine that claims a
    // grid-C column must actually have one, and vice versa.
    const claimed = registry
      .filter((engine) => engine?.appEngineColumn)
      .map((engine) => engine?.id)
      .sort();
    const columns = (matrix.appEngines?.engines ?? [])
      .map((engine) => engine?.id)
      .sort();
    if (JSON.stringify(claimed) !== JSON.stringify(columns))
      errors.push(
        `engineRegistry appEngineColumn set must equal appEngines columns: expected ${columns.join(", ")}; got ${claimed.join(", ")}`
      );
  }

  // ---- The consent ledger (8 permission layers) ---------------------------
  const ledger = matrix.consentLedger;
  if (!Array.isArray(ledger)) {
    errors.push("matrix has no consentLedger");
  } else {
    if (ledger.length !== 8)
      errors.push(
        `consentLedger must declare exactly eight permission layers; got ${ledger.length}`
      );
    const ids = new Set();
    for (const layer of ledger) {
      const label = `consentLedger ${layer?.id ?? "(missing)"}`;
      if (!layer?.id || ids.has(layer.id))
        errors.push(
          `consentLedger id missing or duplicated: ${layer?.id ?? "(missing)"}`
        );
      ids.add(layer?.id);
      if (!layer?.label?.trim()) errors.push(`${label} has no label`);
      if (!Array.isArray(layer?.enforcement) || !layer.enforcement.length)
        errors.push(`${label} names no enforcement point`);
      for (const enforcement of layer?.enforcement ?? []) {
        if (
          typeof enforcement !== "string" ||
          path.isAbsolute(enforcement) ||
          enforcement.includes("..")
        )
          errors.push(
            `${label} enforcement must be a repository-relative path`
          );
        else if (checkFiles && !(await fileExists(cwd, enforcement)))
          errors.push(`${label} enforcement does not exist: ${enforcement}`);
      }
      if (!layer?.refusalGrammar?.trim())
        errors.push(`${label} has no refusal grammar`);
      const symbolRef = /^(?<file>[\w./-]+\.[a-z]+)#/u.exec(
        String(layer?.refusalGrammar ?? "")
      );
      if (
        symbolRef &&
        checkFiles &&
        !(await fileExists(cwd, symbolRef.groups.file))
      )
        errors.push(
          `${label} refusal grammar points at a file that does not exist: ${symbolRef.groups.file}`
        );
      const adversary = layer?.adversary;
      if (!adversary || typeof adversary !== "object") {
        errors.push(`${label} has no adversary record`);
      } else {
        if (adversary.owner != null) {
          if (
            path.isAbsolute(adversary.owner) ||
            adversary.owner.includes("..")
          )
            errors.push(
              `${label} adversary owner must be a repository-relative path`
            );
          else if (checkFiles && !(await fileExists(cwd, adversary.owner)))
            errors.push(
              `${label} adversary owner does not exist: ${adversary.owner}`
            );
        }
        if (adversary.flow != null && !flowIds.has(adversary.flow))
          errors.push(
            `${label} adversary references unknown flow ${adversary.flow}`
          );
        if (
          adversary.owner == null &&
          adversary.flow == null &&
          !openIssue(adversary.trackingIssue)
        )
          errors.push(
            `${label} has no adversary and cites no open tracking issue (#${adversary.trackingIssue ?? "none"})`
          );
      }
      const layerSeats = layer?.seats;
      if (!Array.isArray(layerSeats) || !layerSeats.length)
        errors.push(`${label} binds no seat`);
      for (const seatId of layerSeats ?? [])
        if (!SEAT_IDS.includes(seatId))
          errors.push(`${label} binds unknown seat ${seatId}`);
      if (!layer?.note?.trim()) errors.push(`${label} has no note`);
      for (const match of String(layer?.note ?? "").matchAll(
        /#(?<issue>\d+)/gu
      ))
        if (!issues[match.groups.issue])
          errors.push(
            `${label} note cites unregistered issue #${match.groups.issue}; add it to trackingIssues with its state`
          );
    }
  }

  return errors;
}

export async function validateMatrix(matrix, options = {}) {
  const errors = [];
  const warnings = [];
  const qualities = Array.isArray(matrix.qualities) ? matrix.qualities : [];
  if (Object.hasOwn(matrix, "qualities") && qualities.length !== 7)
    errors.push(
      `matrix must declare exactly seven user-facing qualities; got ${qualities.length}`
    );
  const qualityIds = new Set();
  const gateIds = new Set();
  const qualityFileChecks = [];
  for (const quality of qualities) {
    if (!quality?.id || qualityIds.has(quality.id))
      errors.push(
        `quality id is missing or duplicated: ${quality?.id ?? "(missing)"}`
      );
    qualityIds.add(quality?.id);
    if (!quality?.weakestLink)
      errors.push(
        `quality ${quality?.id ?? "(missing)"} has no weakest-link sentence`
      );
    for (const gate of quality?.gates ?? []) {
      if (!gate?.id || gateIds.has(gate.id))
        errors.push(
          `quality gate id is missing or duplicated: ${gate?.id ?? "(missing)"}`
        );
      gateIds.add(gate?.id);
      const demonstratedRed = matrix.demonstratedRed?.[gate?.id];
      if (
        !demonstratedRed?.command ||
        !demonstratedRed?.seed ||
        !demonstratedRed?.failure
      )
        errors.push(
          `quality gate ${gate?.id ?? "(missing)"} has no replayable demonstrated-red command, seed, and failure signature`
        );
      if (!gate?.evidence)
        errors.push(
          `quality gate ${gate?.id ?? "(missing)"} has no assertion-level evidence selector`
        );
      if (
        !gate?.redLastDemonstrated ||
        Number.isNaN(Date.parse(gate.redLastDemonstrated))
      )
        errors.push(
          `quality gate ${gate?.id ?? "(missing)"} has no demonstrated-red date`
        );
      if (!["tighten-only", "waiver-gated", "none"].includes(gate?.governance))
        errors.push(
          `quality gate ${gate?.id ?? "(missing)"} has no knob governance`
        );
      if (options.checkFiles !== false)
        qualityFileChecks.push(
          ...[
            ["owner", gate?.owner],
            ["knob", gate?.knob?.split("#", 1)[0]],
          ].map(async ([kind, target]) => {
            if (!target)
              return `quality gate ${gate?.id ?? "(missing)"} has no ${kind}`;
            try {
              await access(path.join(options.root ?? root, target));
              return null;
            } catch {
              return `quality gate ${gate.id} ${kind} does not exist: ${target}`;
            }
          })
        );
    }
  }
  for (const id of Object.keys(matrix.demonstratedRed ?? {}))
    if (!gateIds.has(id))
      errors.push(`demonstrated-red evidence points at unknown gate ${id}`);
  errors.push(...(await Promise.all(qualityFileChecks)).filter(Boolean));
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
          } else if (options.checkPartialTracking !== false) {
            // #656 Layer 1E — a partial is a standing debt, so it must name an
            // issue that is still open. Closed issues may stay in the prose as
            // provenance; they cannot be the thing tracking the gap.
            const cited = [...note.matchAll(/#(?<issue>\d+)/gu)].map((match) =>
              Number(match.groups.issue)
            );
            const open = cited.filter(
              (issue) =>
                matrix.trackingIssues?.[String(issue)]?.state === "open"
            );
            if (!open.length) {
              cellErrors.push(
                `${cellId} is partial but cites no open tracking issue (${cited.length ? `only ${cited.map((issue) => `#${issue}`).join(", ")}` : "no issue at all"}); register one in trackingIssues and cite it in the note`
              );
            }
          }
        }
        // An issue number in a note is a claim about the world; keep the
        // ledger honest so a closed issue cannot masquerade as live tracking.
        for (const match of String(notes[cellId] ?? "").matchAll(
          /#(?<issue>\d+)/gu
        )) {
          if (!matrix.trackingIssues?.[match.groups.issue]) {
            cellErrors.push(
              `${cellId} note cites unregistered issue #${match.groups.issue}; add it to trackingIssues with its state`
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
            // A tripwire only works if it globs something real. `contains`
            // makes the trigger a CONTENT check (a COMPAT( shim, a versioned
            // ladder) rather than the existence of a directory that the repo
            // never had — the failure mode that left all nine triggers inert.
            const fired = await fireRevisitTrigger(trigger, {
              cwd: options.root ?? root,
            });
            if (fired.error) {
              cellErrors.push(`${cellId} revisit trigger ${fired.error}`);
            } else if (fired.match) {
              cellErrors.push(
                `${cellId} revisit trigger matched ${fired.match}; convert the skip to a tracked gap or grade the cell`
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

  // A trigger on a cell that is no longer `skip` is dead weight that reads as
  // live protection — the same class of lie as an inert glob.
  for (const cellId of Object.keys(matrix.revisitTriggers ?? {})) {
    if (!expectedCells.has(cellId)) {
      errors.push(`unknown revisit trigger ${cellId}`);
      continue;
    }
    const [surfaceId, dimensionId] = cellId.split(".");
    if (surfaces.get(surfaceId)?.assessment?.[dimensionId] !== "skip") {
      errors.push(
        `${cellId} has a revisit trigger but is not a skip cell; remove the trigger`
      );
    }
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
            // One definition of "how many tests does this file declare",
            // shared with the grade computation — two regexes would let a
            // floor pass one check and fail the other.
            const testCount = countDeclaredTests(source, flow.owner);
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

  // #725 — dense app × shared-engine conformance. A pass points at one real
  // canonical flow; a structural exclusion carries the seat-doctrine anchor.
  const appEngines = matrix.appEngines;
  if (!appEngines || !Array.isArray(appEngines.engines)) {
    errors.push("matrix has no appEngines engine registry");
  } else {
    const engineIds = new Set();
    const engines = new Map();
    for (const engine of appEngines.engines) {
      if (!engine?.id || engineIds.has(engine.id))
        errors.push(
          `appEngines engine id missing or duplicated: ${engine?.id ?? "(missing)"}`
        );
      engineIds.add(engine?.id);
      engines.set(engine?.id, engine);
      if (!flowIds.has(engine?.flow))
        errors.push(
          `appEngines engine ${engine?.id ?? "(missing)"} references unknown flow ${engine?.flow ?? "(missing)"}`
        );
    }
    const declaredApps = new Set();
    for (const app of appEngines.apps ?? []) {
      if (!app?.id || declaredApps.has(app.id))
        errors.push(
          `appEngines app id missing or duplicated: ${app?.id ?? "(missing)"}`
        );
      declaredApps.add(app?.id);
      for (const engineId of engineIds) {
        const cell = app?.engines?.[engineId];
        if (!cell) {
          errors.push(`appEngines ${app?.id}.${engineId} is missing`);
          continue;
        }
        if (cell.status === "pass") {
          const expectedFlow = engines.get(engineId)?.flow;
          if (cell.flow !== expectedFlow || !flowIds.has(cell.flow))
            errors.push(
              `appEngines ${app.id}.${engineId} must reference real gate ${expectedFlow}`
            );
        } else if (cell.status === "skip") {
          if (!cell.reason?.trim())
            errors.push(
              `appEngines ${app.id}.${engineId} skip has no structural reason`
            );
          if (cell.citation !== appEngines.seatDoctrine)
            errors.push(
              `appEngines ${app.id}.${engineId} skip must cite ${appEngines.seatDoctrine}`
            );
        } else {
          errors.push(
            `appEngines ${app.id}.${engineId} has invalid status ${cell.status}`
          );
        }
      }
      for (const engineId of Object.keys(app?.engines ?? {}))
        if (!engineIds.has(engineId))
          errors.push(
            `appEngines ${app.id} references unknown engine ${engineId}`
          );
    }
    if (options.checkFiles !== false) {
      const appManifests = [];
      for await (const manifest of glob("packages/blueprints/apps/*/app.json", {
        cwd: options.root ?? root,
      })) {
        appManifests.push(path.posix.basename(path.posix.dirname(manifest)));
      }
      const expectedApps = appManifests
        .filter((id) => !id.startsWith("_"))
        .sort();
      const actualApps = [...declaredApps].sort();
      if (JSON.stringify(actualApps) !== JSON.stringify(expectedApps))
        errors.push(
          `appEngines app registry must exactly match bundled apps: expected ${expectedApps.join(", ")}; got ${actualApps.join(", ")}`
        );
      const [doctrinePath, anchor] = String(
        appEngines.seatDoctrine ?? ""
      ).split("#");
      try {
        const doctrine = await readFile(
          path.join(options.root ?? root, doctrinePath),
          "utf8"
        );
        const heading = String(anchor ?? "")
          .split("-")
          .map((word) => word.replace(/^./u, (letter) => letter.toUpperCase()))
          .join(" ");
        if (
          !anchor ||
          !new RegExp(`^#{1,6}\\s+${heading}\\s*$`, "imu").test(doctrine)
        )
          errors.push(
            `appEngines seat doctrine anchor does not exist: ${appEngines.seatDoctrine}`
          );
      } catch {
        errors.push(
          `appEngines seat doctrine does not exist: ${appEngines.seatDoctrine}`
        );
      }
    }
  }

  errors.push(...(await validateAppAxes(matrix, options, flowIds)));

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

  // #656 Layer 2 — the declared assessment is checked against computed
  // evidence, and the skip population is checked against its committed budget.
  // Both are opt-in so existing callers (the report generator, unit fixtures)
  // keep their previous contract.
  let grades;
  let skips;
  if (options.computeGrades) {
    const skipSites =
      options.skipSites ??
      (await discoverSkipSites({ root: options.root ?? root }));
    const inventory =
      options.skipInventory ??
      JSON.parse(
        await readFile(
          path.join(options.root ?? root, "tests/skips.json"),
          "utf8"
        )
      );
    skips = validateSkipInventory(inventory, skipSites, {
      trackingIssues: matrix.trackingIssues ?? {},
    });
    errors.push(...skips.errors.map((error) => `skip budget: ${error}`));
    warnings.push(
      ...skips.warnings.map((warning) => `skip budget: ${warning}`)
    );

    grades = await gradeMatrix(matrix, {
      root: options.root ?? root,
      checkRunEvidence: options.checkRunEvidence,
      nowMs: options.nowMs,
    });
    errors.push(...grades.errors.map((error) => `computed grade: ${error}`));
    warnings.push(
      ...grades.warnings.map((warning) => `computed grade: ${warning}`)
    );
  }

  return { errors, warnings, dimensions, surfaces, flowIds, grades, skips };
}

async function main() {
  const matrixPath = path.resolve(
    process.argv[2] ?? path.join(root, "tests/matrix.json")
  );
  const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
  const { errors, warnings, surfaces, dimensions, flowIds, grades, skips } =
    await validateMatrix(matrix, {
      warnMissingMinimumTests: true,
      computeGrades: true,
    });
  for (const w of warnings ?? []) console.warn(`matrix: warning: ${w}`);
  if (errors.length) {
    for (const error of errors) console.error(`matrix: ${error}`);
    process.exitCode = 1;
    return;
  }
  const graded = grades?.cells?.length ?? 0;
  console.log(
    `matrix: ${surfaces.size} surfaces × ${dimensions.size} dimensions, ${flowIds.size} canonical flows`
  );
  console.log(
    `matrix: ${graded} owned cells graded from evidence (run evidence: ${grades?.runEvidence ?? "n/a"}), ${skips?.count ?? 0} inventoried skips`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  await main();
}
