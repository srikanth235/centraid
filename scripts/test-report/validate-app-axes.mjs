import { access, glob, readFile } from "node:fs/promises";
import path from "node:path";

import { MUTATION_SEEDS } from "../mutation/seeds.mjs";
import { validateReportRegistries } from "./validate-report-registries.mjs";

const root = path.resolve(import.meta.dirname, "../..");
/**
 * The three client seats (docs/blueprint-seats.md). A seat is WHERE bytes live
 * and which way they flow — orthogonal to form factor — so the set is closed
 * by product doctrine, not by what happens to be built.
 */
const SEAT_IDS = ["origin", "custodian", "viewer"];

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
 * The `states` block of a bundled app manifest — the design's own word on
 * which honest states the app owes — or the error explaining why grid D has
 * nothing to mirror.
 */
async function readManifestStates(cwd, appId) {
  const manifestPath = `packages/blueprints/apps/${appId}/app.json`;
  try {
    const { states } = JSON.parse(
      await readFile(path.join(cwd, manifestPath), "utf8")
    );
    if (!Array.isArray(states?.designed) || !Array.isArray(states?.excluded))
      return { error: `appStates ${appId} manifest declares no states block` };
    return { states };
  } catch {
    return { error: `appStates ${appId} has no manifest at ${manifestPath}` };
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
 *
 * Lifted out of `validate-matrix.mjs` — which stays the law's entry point and
 * calls this as one step of `validateMatrix` — purely so neither file outgrows
 * the repo-hygiene file-size limit.
 */
export async function validateAppAxes(matrix, options, flowIds) {
  const errors = [];
  const cwd = options.root ?? root;
  const checkFiles = options.checkFiles !== false;
  const issues = matrix.trackingIssues ?? {};
  const openIssue = (issue) => issues[String(issue)]?.state === "open";

  // Every disk check is DEFERRED into one `Promise.all`: these blocks name
  // hundreds of paths, and a validator that stats them one await at a time is
  // needlessly serial. Each deferred check resolves to an error string or null.
  const deferred = [];
  function requirePath(target, message) {
    if (!checkFiles) return;
    deferred.push(
      fileExists(cwd, target).then((found) =>
        found ? null : `${message}: ${target}`
      )
    );
  }
  // One anchor cache, keyed by the PROMISE so concurrent citations of the same
  // document read it once. A citation pointing at a heading the doc does not
  // have reads as doctrine while protecting nothing.
  const anchorCache = new Map();
  function anchorsFor(docPath) {
    if (!anchorCache.has(docPath))
      anchorCache.set(
        docPath,
        documentAnchors(cwd, docPath).catch(() => null)
      );
    return anchorCache.get(docPath);
  }
  async function citationError(citation, label) {
    const [docPath, anchor] = String(citation ?? "").split("#");
    if (!docPath || !anchor) return `${label} citation is not a doc#anchor`;
    if (!checkFiles) return null;
    const anchors = await anchorsFor(docPath);
    if (!anchors)
      return `${label} citation document does not exist: ${docPath}`;
    return anchors.has(anchor)
      ? null
      : `${label} citation anchor does not exist: ${citation}`;
  }

  const seats = Array.isArray(matrix.seats) ? matrix.seats : null;
  const seatIds = seats?.map((seat) => seat?.id) ?? [];
  if (seats) {
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
      if (seat?.doctrine?.trim())
        deferred.push(citationError(seat.doctrine, `seat ${seat.id}`));
      else
        errors.push(`seat ${seat?.id ?? "(missing)"} has no doctrine citation`);
    }
  } else {
    errors.push("matrix has no seats registry");
  }

  const [expectedApps, manifestStates] = await Promise.all([
    checkFiles ? bundledAppIds(cwd) : null,
    // Grid D mirrors each app's own manifest, so read them all up front.
    checkFiles && Array.isArray(matrix.appStates?.apps)
      ? Promise.all(
          matrix.appStates.apps.map(async (app) => [
            app?.id,
            await readManifestStates(cwd, app?.id),
          ])
        ).then((entries) => new Map(entries))
      : new Map(),
  ]);
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
          else requirePath(cell.owner, `${label} owner does not exist`);
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
            deferred.push(citationError(citation, `${label} skip`));
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
      const manifest = manifestStates.get(app?.id);
      if (manifest?.error) errors.push(manifest.error);
      const designed = new Set(manifest?.states?.designed);
      const excluded = new Set(
        manifest?.states?.excluded?.map((entry) => entry?.state ?? entry)
      );
      if (manifest?.states) {
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
          else requirePath(cell.owner, `${label} owner does not exist`);
        } else if (cell.status === "held") {
          // A HELD state is designed, unbuilt, and NOT a gap: the interface it
          // would belong to was cleared by a ruling, so no owner can exist
          // until that ruling's redesign lands. The citation is that ruling —
          // registered so it is followable, and NOT required to be open,
          // because the issue closes when the clearing lands while the hold
          // itself continues. Silence is the thing this forbids: a held cell
          // renders with its citation rather than vanishing into the grey.
          const citation = String(cell.citation ?? "");
          const issueRef = /^#(?<issue>\d+)$/u.exec(citation);
          if (!issueRef)
            errors.push(
              `${label} is held but cites no issue; use the ruling that held it, e.g. #831 (got ${citation || "none"})`
            );
          else if (!issues[issueRef.groups.issue])
            errors.push(
              `${label} held cites unregistered issue ${citation}; add it to trackingIssues`
            );
        } else if (cell.status !== "gap" && cell.status !== "excluded") {
          errors.push(`${label} has invalid status ${cell.status}`);
        }
        if (!manifest?.states) continue;
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
        else requirePath(source, `${label} source does not exist`);
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
  if (Array.isArray(ledger)) {
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
        else requirePath(enforcement, `${label} enforcement does not exist`);
      }
      if (!layer?.refusalGrammar?.trim())
        errors.push(`${label} has no refusal grammar`);
      const symbolRef = /^(?<file>[\w./-]+\.[a-z]+)#/u.exec(
        String(layer?.refusalGrammar ?? "")
      );
      if (symbolRef)
        requirePath(
          symbolRef.groups.file,
          `${label} refusal grammar points at a file that does not exist`
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
          else
            requirePath(
              adversary.owner,
              `${label} adversary owner does not exist`
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
  } else {
    errors.push("matrix has no consentLedger");
  }

  // #839 Wave 5 — grids E and G rest on two more registry blocks, `joinLaws`
  // and `journeys`. Their locks read the owning suites and Maestro runners off
  // disk (see `validate-report-registries.mjs`), so they ride the same
  // `checkFiles` switch as every other on-disk check here; `options` carries
  // the root through unchanged. `checkReportRegistries: false` lets a fixture
  // that exercises an unrelated rule opt out without also disabling the file
  // checks it does need — the real matrix never passes it.
  if (checkFiles && options.checkReportRegistries !== false)
    errors.push(...(await validateReportRegistries(matrix, options)));

  errors.push(...(await Promise.all(deferred)).filter(Boolean));
  return errors;
}
