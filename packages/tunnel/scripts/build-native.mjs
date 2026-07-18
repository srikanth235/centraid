import { copyFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
