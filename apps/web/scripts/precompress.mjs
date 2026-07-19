import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);
const root = path.resolve('dist');
const COMPRESSIBLE = new Set(['.css', '.js', '.json', '.mjs', '.svg', '.wasm', '.webmanifest']);
const MIN_BYTES = 1024;

async function filesUnder(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(file)));
    else if (entry.isFile()) out.push(file);
  }
  return out;
}

let emitted = 0;
for (const file of await filesUnder(root)) {
  if (!COMPRESSIBLE.has(path.extname(file))) continue;
  const bytes = await fs.readFile(file);
  if (bytes.length < MIN_BYTES) continue;
  const [br, gz] = await Promise.all([
    compressBrotli(bytes, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 9,
        [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
      },
    }),
    compressGzip(bytes, { level: 9 }),
  ]);
  await Promise.all([fs.writeFile(`${file}.br`, br), fs.writeFile(`${file}.gz`, gz)]);
  emitted += 2;
}

process.stdout.write(`[precompress] emitted ${emitted} static sidecars\n`);
