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
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) return filesUnder(file);
        return entry.isFile() ? [file] : [];
      }),
    )
  ).flat();
}

const emitted = (
  await Promise.all(
    (
      await filesUnder(root)
    ).map(async (file) => {
      if (!COMPRESSIBLE.has(path.extname(file))) return 0;
      const bytes = await fs.readFile(file);
      if (bytes.length < MIN_BYTES) return 0;
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
      return 2;
    }),
  )
).reduce((sum, count) => sum + count, 0);

process.stdout.write(`[precompress] emitted ${emitted} static sidecars\n`);
