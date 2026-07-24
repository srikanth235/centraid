/**
 * Pure helpers for the test-health report inventory signals (#464 backlog).
 * Kept free of I/O so unit tests drive the real logic without regenerating HTML.
 */

/**
 * Extract unhandled/uncaught Vitest errors from a Jest-compatible vitest JSON
 * report. Also detects success=false with zero failed assertions (the EPIPE
 * class of "all tests green, process still fails").
 */
export function extractUnhandledErrors(vitest) {
  if (!vitest || typeof vitest !== 'object') return [];
  const messages = [];

  if (Array.isArray(vitest.unhandledErrors)) {
    for (const entry of vitest.unhandledErrors) {
      if (typeof entry === 'string') messages.push(entry);
      else if (entry && typeof entry === 'object') {
        messages.push(String(entry.message ?? entry.name ?? entry));
      }
    }
  }

  let failedAssertions = 0;
  for (const file of vitest.testResults ?? vitest.files ?? []) {
    for (const assertion of file.assertionResults ?? file.tests ?? []) {
      if (assertion.status === 'failed') failedAssertions += 1;
    }
    // Suite-level failure with no assertions often means load/runtime error.
    if (
      file.status === 'failed' &&
      !(file.assertionResults ?? file.tests ?? []).some((t) => t.status === 'failed')
    ) {
      const msg = file.message || file.name || file.filepath || 'suite failed without assertions';
      messages.push(String(msg));
    }
  }

  if (vitest.success === false && failedAssertions === 0) {
    const hasExplicit = messages.length > 0;
    if (!hasExplicit) {
      messages.push(
        'vitest reported success=false with zero failed tests (likely unhandled exception)',
      );
    }
  }

  return [...new Set(messages)];
}

/**
 * Summarize matrix cell states so "lane ran and failed" is distinct from
 * "no evidence / not run" in the report model.
 */
export function summarizeCellStates(cells) {
  const counts = {
    cellsPassed: 0,
    cellsFailed: 0,
    cellsMissing: 0,
    cellsSkipped: 0,
    cellsStale: 0,
  };
  for (const cell of cells ?? []) {
    if (cell.state === 'passed') counts.cellsPassed += 1;
    else if (cell.state === 'failed') counts.cellsFailed += 1;
    else if (cell.state === 'missing') counts.cellsMissing += 1;
    else if (cell.state === 'skipped') counts.cellsSkipped += 1;
    else if (cell.state === 'stale') counts.cellsStale += 1;
  }
  return counts;
}

/**
 * Detect whole-file env gates that mean the owner never runs on default CI
 * (no special CENTRAID_* flags). Used by matrix validation and report inventory.
 */
export function detectDefaultCiEnvGate(source) {
  if (typeof source !== 'string' || !source.trim()) return null;
  // describe.skipIf(process.env.FOO !== '1')
  const skipIfNeq = source.match(
    /describe\.skipIf\(\s*process\.env\.([A-Z0-9_]+)\s*!==\s*['"]1['"]\s*\)/,
  );
  if (skipIfNeq) return { env: skipIfNeq[1], kind: 'skipIf-env-not-1' };
  // describe.skipIf(!enabled) where enabled = process.env.X === '1' nearby
  const enabled =
    source.match(/const\s+\w+\s*=\s*process\.env\.([A-Z0-9_]+)\s*===\s*['"]1['"]/) ||
    source.match(/const\s+\w+\s*=\s*process\.env\.([A-Z0-9_]+)\s*===\s*['"]1['"]\s*\|\|/);
  if (enabled && /describe\.skipIf\(\s*!?\w+\s*\)/.test(source)) {
    return { env: enabled[1], kind: 'skipIf-enabled-flag' };
  }
  // if (process.env.FOO !== '1') { t.skip / test.skip / describe.skip / return }
  // Covers disk-full.integration.test.ts style: env check then t.skip in the
  // test callback (whole owner is a no-op on default CI without the flag).
  const skipCall = '(?:test|it|t|describe)\\.skip';
  const early =
    source.match(
      new RegExp(
        String.raw`if\s*\(\s*process\.env\.([A-Z0-9_]+)\s*!==\s*['"]1['"]\s*\)\s*\{[\s\S]{0,200}?${skipCall}`,
      ),
    ) ||
    source.match(
      new RegExp(
        String.raw`if\s*\(\s*process\.env\.([A-Z0-9_]+)\s*!==\s*['"]1['"]\s*\)\s*${skipCall}`,
      ),
    ) ||
    source.match(
      /if\s*\(\s*process\.env\.([A-Z0-9_]+)\s*!==\s*['"]1['"]\s*\)\s*\{[\s\S]{0,200}?\breturn\b/,
    );
  if (early) return { env: early[1], kind: 'early-env-return' };
  return null;
}

/** Inventory solid/partial cell owners that are whole-file env-gated off default CI. */
export async function collectEnvGatedOwners(manifest, { root, readFile }) {
  const rows = [];
  for (const [cellId, cellOwner] of Object.entries(manifest.cellOwners ?? {})) {
    if (!cellOwner?.owner) continue;
    const [surfaceId, dimensionId] = cellId.split('.');
    const surface = (manifest.surfaces ?? []).find((entry) => entry.id === surfaceId);
    const assessment = surface?.assessment?.[dimensionId];
    if (assessment !== 'solid' && assessment !== 'partial') continue;
    try {
      const source = await readFile(`${root}/${cellOwner.owner}`, 'utf8');
      const gate = detectDefaultCiEnvGate(source);
      if (gate) {
        rows.push({
          cellId,
          owner: cellOwner.owner,
          assessment,
          env: gate.env,
          kind: gate.kind,
        });
      }
    } catch {
      // missing file is a matrix validation error, not inventory
    }
  }
  return rows;
}

/**
 * Collect every owner path registered on the matrix (cellOwners + flows).
 * Used to detect orphaned e2e evidence that would otherwise drop on the floor (#535 F3).
 */
export function collectRegisteredOwners(manifest) {
  const owners = new Set();
  for (const cellOwner of Object.values(manifest?.cellOwners ?? {})) {
    if (cellOwner?.owner) owners.add(String(cellOwner.owner).replaceAll('\\', '/'));
  }
  for (const flow of manifest?.flows ?? []) {
    if (flow?.owner) owners.add(String(flow.owner).replaceAll('\\', '/'));
  }
  return owners;
}

/**
 * Evidence JSON whose owner is not registered on any matrix cell/flow.
 * @returns {{ unmapped: object[], failedUnmapped: object[], unmappedEvidence: number }} Unmapped rows and counts.
 */
export function findUnmappedEvidence(results, manifest, { normalizeOwner } = {}) {
  const registered = collectRegisteredOwners(manifest);
  const norm =
    typeof normalizeOwner === 'function'
      ? normalizeOwner
      : (value) => String(value ?? '').replaceAll('\\', '/');
  const unmapped = [];
  for (const result of results ?? []) {
    const owner = norm(result?.owner);
    if (!owner) continue;
    if (!registered.has(owner)) unmapped.push({ ...result, owner });
  }
  const failedUnmapped = unmapped.filter((item) => {
    const status = String(item.status ?? '').toLowerCase();
    return status === 'failed' || status === 'fail' || status === 'error';
  });
  return {
    unmapped,
    failedUnmapped,
    unmappedEvidence: unmapped.length,
  };
}

/**
 * Reconcile evidence-producing needs.* job conclusions against report summary.
 * When any needed job failed but summary.failed is 0, the report must not
 * present an implicit all-clear (#535 F5).
 *
 * @param {Record<string, { result?: string }>|null|undefined} needs GHA needs.* map (or job-conclusions.json).
 * @param {{ failed?: number }|null|undefined} summary Report evidence summary with failed count.
 * @param {{ evidenceJobs?: string[] }} [options] Optional allowlist of job names to consider.
 */
export function reconcileJobConclusions(needs, summary, options = {}) {
  const evidenceJobs = options.evidenceJobs ?? null;
  const failedJobs = [];
  for (const [job, info] of Object.entries(needs ?? {})) {
    if (evidenceJobs && !evidenceJobs.includes(job)) continue;
    const result = info?.result ?? info?.conclusion ?? info;
    if (result === 'failure' || result === 'failed') failedJobs.push(job);
  }
  failedJobs.sort();
  const evidenceFailed = Number(summary?.failed ?? 0);
  const silentAllClear = failedJobs.length > 0 && evidenceFailed === 0;
  return {
    failedJobs,
    silentAllClear,
    message: silentAllClear
      ? `Evidence-producing job(s) failed but report shows failed: 0 — ${failedJobs.join(', ')}`
      : null,
  };
}

/**
 * Ratchet cellsMissing vs the prior durable-history point (#535 F5).
 * historyPoints: oldest-first series *excluding* the current run.
 */
export function cellsMissingRatchet(currentMissing, historyPoints) {
  const current = Number(currentMissing ?? 0);
  const priorPoints = (historyPoints ?? []).filter(
    (point) => point != null && Number.isFinite(Number(point.cellsMissing)),
  );
  if (!priorPoints.length) {
    return { prior: null, current, delta: 0, rose: false };
  }
  const prior = Number(priorPoints.at(-1).cellsMissing);
  const delta = current - prior;
  return { prior, current, delta, rose: delta > 0 };
}

/**
 * Drop `_`-prefixed / non-scope meta keys from a floors-style config
 * (e.g. coverage-floors `_comment`) so they never render as coverage rows.
 */
export function filterFloorConfigEntries(floorConfig) {
  return Object.entries(floorConfig ?? {}).filter(
    ([key, value]) =>
      !key.startsWith('_') &&
      key !== 'approvedDeviation' &&
      (typeof value === 'number' || (value && typeof value === 'object')),
  );
}

/**
 * Merge per-lane marker maps written as `lane-starts-<lane>.json` (and the
 * legacy single `lane-starts.json`) so merge-multiple never last-write-wins.
 */
export function mergeLaneMarkers(markerMaps) {
  const merged = {};
  for (const map of markerMaps ?? []) {
    if (!map || typeof map !== 'object') continue;
    for (const [lane, at] of Object.entries(map)) {
      if (typeof at === 'string' && at) merged[lane] = at;
    }
  }
  return merged;
}
