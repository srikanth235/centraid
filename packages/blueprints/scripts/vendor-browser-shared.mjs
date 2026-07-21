// Build canonical workspace modules into the shared browser kit. Apps import
// these as root-level siblings, which the gateway serves from SHARED_ASSET_FILES
// in per-file mode and inlines into whole-app bundles.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const PACKAGE_ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const WORKSPACE_ROOT = path.resolve(PACKAGE_ROOT, '../..');

const modules = [
  {
    source: 'packages/blob-format/src/index.ts',
    outfile: 'kit/blob-format.js',
  },
  {
    source: 'packages/client/src/video-frame.ts',
    outfile: 'kit/video-frame.js',
  },
];

for (const module of modules) {
  const outfile = path.join(PACKAGE_ROOT, module.outfile);
  await build({
    entryPoints: [path.join(WORKSPACE_ROOT, module.source)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    legalComments: 'none',
    // Resolve workspace packages from TypeScript sources so vendor does not
    // require a pre-built packages/*/dist (CI pure-local jobs skip turbo build).
    packages: 'bundle',
    alias: {
      '@centraid/blob-format': path.join(WORKSPACE_ROOT, 'packages/blob-format/src/index.ts'),
    },
    banner: {
      js: `// Generated from ${module.source} by scripts/vendor-browser-shared.mjs.`,
    },
  });
  console.log(`Built shared browser module → ${outfile}`);
}
