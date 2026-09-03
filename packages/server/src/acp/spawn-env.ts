import path from "node:path";

const NODE_MODULES_BIN_RE = /[\\/]node_modules[\\/]\.bin[\\/]?$/u;

export function sanitizeHarnessPath(pathValue: string | undefined): string {
  if (!pathValue) return "";
  return pathValue
    .split(path.delimiter)
    .filter((entry) => !NODE_MODULES_BIN_RE.test(entry))
    .join(path.delimiter);
}

export interface HarnessSpawnEnvOptions {
  baseEnv?: NodeJS.ProcessEnv;
  binPath?: string;
  extraPath?: string;
}

export function harnessSpawnEnv(
  opts: HarnessSpawnEnvOptions = {}
): NodeJS.ProcessEnv {
  const base = opts.baseEnv ?? process.env;
  const currentPath = base.PATH ?? "";
  const sanitized = opts.binPath
    ? currentPath
    : sanitizeHarnessPath(currentPath);
  const finalPath = opts.extraPath
    ? sanitized
      ? `${opts.extraPath}${path.delimiter}${sanitized}`
      : opts.extraPath
    : sanitized;
  return { ...base, PATH: finalPath };
}
