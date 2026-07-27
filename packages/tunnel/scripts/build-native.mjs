import { copyFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');

// Packaging / Docker set CENTRAID_REQUIRE_NATIVE_TUNNEL=1 — tunnel is product-
// critical for remote devices; fail the build if cargo or the artifact is missing.
// CENTRAID_SKIP_NATIVE_TUNNEL=1 remains for local TS-only loops (not Docker).
const requireNative = process.env.CENTRAID_REQUIRE_NATIVE_TUNNEL === '1';
if (process.env.CENTRAID_SKIP_NATIVE_TUNNEL === '1') {
  if (requireNative) {
    process.stderr.write(
      'centraid-tunnel: CENTRAID_REQUIRE_NATIVE_TUNNEL=1 and CENTRAID_SKIP_NATIVE_TUNNEL=1 conflict\n',
    );
    process.exit(1);
  }
  process.stdout.write('centraid-tunnel: skipping native build (CENTRAID_SKIP_NATIVE_TUNNEL=1)\n');
  process.exit(0);
}
const cargoProbe = spawnSync('cargo', ['--version'], { encoding: 'utf8' });
if (cargoProbe.status !== 0) {
  if (requireNative) {
    process.stderr.write(
      'centraid-tunnel: cargo required (CENTRAID_REQUIRE_NATIVE_TUNNEL=1) but not on PATH\n',
    );
    process.exit(1);
  }
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

// macOS: cargo emits a *linker-signed* Mach-O, a lightweight signature that
// does not survive being re-materialized by a generic copy (our copyFileSync
// above, a turbo cache restore, an npm tarball extract). The file still passes
// `codesign --verify`, but the kernel rejects its pages at fault-in time and
// SIGKILLs the host process the moment Node dlopen()s it:
//   EXC_BAD_ACCESS · SIGKILL (Code Signature Invalid) · CODESIGNING/Invalid Page
// A full ad-hoc signature is self-contained and survives any copy, so sign here
// — before the artifact enters the turbo cache or a publish tarball.
if (process.platform === 'darwin') {
  const signed = spawnSync('codesign', ['--force', '--sign', '-', destination], {
    stdio: 'inherit',
  });
  if (signed.error || signed.status !== 0) {
    process.stderr.write(
      `centraid-tunnel: codesign failed for ${destination}; the addon would be SIGKILLed on load\n`,
    );
    process.exit(signed.status ?? 1);
  }
}

process.stdout.write(`${destination}\n`);
