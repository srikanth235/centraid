import { copyFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Gateway Docker / CI packaging builds TypeScript only (HTTP control plane).
// Native iroh relay is optional at runtime (JS fallback). Set explicitly or
// when cargo is missing so `turbo build --filter=@centraid/gateway` works
// without a Rust toolchain in the image.
if (process.env.CENTRAID_SKIP_NATIVE_TUNNEL === '1') {
  process.stdout.write('centraid-tunnel: skipping native build (CENTRAID_SKIP_NATIVE_TUNNEL=1)\n');
  process.exit(0);
}
const cargoProbe = spawnSync('cargo', ['--version'], { encoding: 'utf8' });
if (cargoProbe.status !== 0) {
  process.stdout.write(
    'centraid-tunnel: skipping native build (cargo not available; JS relay fallback)\n',
  );
  process.exit(0);
}

const release = process.argv.includes('--release');
const args = ['build', '--manifest-path', path.join(root, 'native', 'Cargo.toml'), '--locked'];
if (release) args.push('--release');
const built = spawnSync('cargo', args, { cwd: root, stdio: 'inherit' });
if (built.status !== 0) process.exit(built.status ?? 1);

const library =
  process.platform === 'win32'
    ? 'centraid_tunnel_native.dll'
    : process.platform === 'darwin'
      ? 'libcentraid_tunnel_native.dylib'
      : 'libcentraid_tunnel_native.so';
const profile = release ? 'release' : 'debug';
const source = path.join(root, 'native', 'target', profile, library);
const destination = path.join(
  root,
  'native',
  `centraid-tunnel-native.${process.platform}-${process.arch}.node`,
);
copyFileSync(source, destination);
process.stdout.write(`${destination}\n`);
