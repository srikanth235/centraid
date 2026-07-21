// Embed the @centraid/web PWA build into the gateway's publishable dist
// (`dist/web`), so the standalone `centraid-gateway` daemon can serve it
// (cli.ts `bundledWebRoot`). Locating the package via module resolution —
// not a `../../apps/web` relative path — keeps the dependency edge stated
// exactly once, in package.json: turbo orders the builds off the devDep,
// and knip proves the devDep is consumed by parsing this import specifier.
import { cpSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const webPkg = require.resolve('@centraid/web/package.json');
const webDist = path.join(path.dirname(webPkg), 'dist');
const target = fileURLToPath(new URL('../dist/web', import.meta.url));

rmSync(target, { recursive: true, force: true });
cpSync(webDist, target, { recursive: true });
