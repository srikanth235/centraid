import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectDefaultCiEnvGate } from './report-signals.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const allowedStatuses = new Set(['solid', 'partial', 'gap', 'skip']);

export async function validateMatrix(matrix, options = {}) {
  const errors = [];
  const dimensions = new Map(matrix.dimensions?.map((dimension) => [dimension.id, dimension]));
  const surfaces = new Map(matrix.surfaces?.map((surface) => [surface.id, surface]));
  const flowIds = new Set();
  const expectedCells = new Set();

  if (!dimensions.size) errors.push('matrix has no dimensions');
  if (!surfaces.size) errors.push('matrix has no surfaces');

  for (const surface of surfaces.values()) {
    for (const dimension of dimensions.values()) {
      const cellId = `${surface.id}.${dimension.id}`;
      expectedCells.add(cellId);
      const status = surface.assessment?.[dimension.id];
      if (!allowedStatuses.has(status)) {
        errors.push(`${surface.id}.${dimension.id} has invalid or missing assessment ${status}`);
      }
      const cellOwner = matrix.cellOwners?.[cellId];
      if (!(cellId in (matrix.cellOwners ?? {}))) {
        errors.push(`${cellId} has no explicit cell-owner mapping`);
      } else if (status === 'solid' || status === 'partial') {
        if (!cellOwner || typeof cellOwner.owner !== 'string' || !cellOwner.owner) {
          errors.push(`${cellId} is ${status} but has no owning test`);
        } else if (typeof cellOwner.tier !== 'string' || !cellOwner.tier) {
          errors.push(`${cellId} is ${status} but has no owning tier`);
        } else if (path.isAbsolute(cellOwner.owner) || cellOwner.owner.includes('..')) {
          errors.push(`${cellId} owner must be a repository-relative path`);
        } else if (options.checkFiles !== false) {
          try {
            const ownerPath = path.join(options.root ?? root, cellOwner.owner);
            await access(ownerPath);
            // Solid/partial cells whose only owner is whole-file env-gated off
            // default CI claim coverage they never get on PR/nightly defaults.
            if (options.checkEnvGates !== false && !cellOwner.owner.endsWith('.mjs')) {
              try {
                const source = await readFile(ownerPath, 'utf8');
                const gate = detectDefaultCiEnvGate(source);
                if (gate) {
                  errors.push(
                    `${cellId} is ${status} but owner ${cellOwner.owner} is always env-gated off default CI (${gate.env} / ${gate.kind}); demote assessment or ungated the suite`,
                  );
                }
              } catch {
                // access already succeeded
              }
            }
          } catch {
            errors.push(`${cellId} owner does not exist: ${cellOwner.owner}`);
          }
        }
      } else if (cellOwner !== null) {
        errors.push(`${cellId} is ${status} and must map explicitly to null`);
      }
    }
    for (const assessment of Object.keys(surface.assessment ?? {})) {
      if (!dimensions.has(assessment))
        errors.push(`${surface.id} references unknown dimension ${assessment}`);
    }
  }

  for (const cellId of Object.keys(matrix.cellOwners ?? {})) {
    if (!expectedCells.has(cellId)) errors.push(`unknown cell-owner mapping ${cellId}`);
  }

  for (const flow of matrix.flows ?? []) {
    if (flowIds.has(flow.id)) errors.push(`duplicate flow id ${flow.id}`);
    flowIds.add(flow.id);
    if (!surfaces.has(flow.surface))
      errors.push(`${flow.id} references unknown surface ${flow.surface}`);
    if (!dimensions.has(flow.dimension)) {
      errors.push(`${flow.id} references unknown dimension ${flow.dimension}`);
    }
    if (typeof flow.owner !== 'string' || !flow.owner) {
      errors.push(`${flow.id} must have exactly one owning file`);
      continue;
    }
    if (path.isAbsolute(flow.owner) || flow.owner.includes('..')) {
      errors.push(`${flow.id} owner must be a repository-relative path`);
      continue;
    }
    if (options.checkFiles !== false) {
      try {
        const ownerPath = path.join(options.root ?? root, flow.owner);
        await access(ownerPath);
        if (flow.minimumTests !== undefined) {
          const source = await readFile(ownerPath, 'utf8');
          const testCount = source.match(/\b(?:test|it)\s*\(/g)?.length ?? 0;
          if (testCount < flow.minimumTests) {
            errors.push(
              `${flow.id} contract shrank: ${testCount} tests, minimum ${flow.minimumTests}`,
            );
          }
        }
      } catch {
        errors.push(`${flow.id} owner does not exist: ${flow.owner}`);
      }
    }
  }

  return { errors, dimensions, surfaces, flowIds };
}

async function main() {
  const matrixPath = path.resolve(process.argv[2] ?? path.join(root, 'tests/matrix.json'));
  const matrix = JSON.parse(await readFile(matrixPath, 'utf8'));
  const { errors, surfaces, dimensions, flowIds } = await validateMatrix(matrix);
  if (errors.length) {
    for (const error of errors) console.error(`matrix: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `matrix: ${surfaces.size} surfaces × ${dimensions.size} dimensions, ${flowIds.size} canonical flows`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
