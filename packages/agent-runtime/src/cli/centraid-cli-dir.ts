/*
 * Resolve the directory containing the built `centraid` CLI bin. Used by
 * the builder agent-session to inject the dist-dir onto PATH so the
 * agent's shell tool can invoke `centraid preview snapshot` by bare name.
 */

export function defaultCentraidCliDir(): string {
  return import.meta.dirname;
}
