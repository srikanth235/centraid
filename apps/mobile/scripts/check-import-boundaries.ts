import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..', 'src');
const sourceExtensions = new Set(['.ts', '.tsx']);

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const target = path.join(dir, entry.name);
        if (entry.isDirectory()) return filesUnder(target);
        return sourceExtensions.has(path.extname(entry.name)) ? [target] : [];
      }),
    )
  ).flat();
}

function appOf(file: string): string | undefined {
  const relative = path.relative(path.join(root, 'apps'), file);
  return relative.startsWith('..') ? undefined : relative.split(path.sep)[0];
}

const errors: string[] = [];
for (const file of await filesUnder(root)) {
  const source = await readFile(file, 'utf8');
  const fromApp = appOf(file);
  for (const match of source.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)) {
    const specifier = match[2]!;
    if (!specifier.startsWith('.')) continue;
    const targetApp = appOf(path.resolve(path.dirname(file), specifier));
    const label = path.relative(root, file);
    if (!fromApp && targetApp)
      errors.push(`${label}: platform/kit may not import app ${targetApp}`);
    else if (fromApp && targetApp && fromApp !== targetApp) {
      errors.push(`${label}: app ${fromApp} may not import app ${targetApp}`);
    }
  }
}

if (errors.length > 0) throw new Error(`Mobile import boundaries failed:\n${errors.join('\n')}`);
