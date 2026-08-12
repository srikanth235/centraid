/*
 * Resolve the directory containing the built `centraid` CLI bin. Used by
 * the builder harness session to inject the dist-dir onto PATH so the
 * harness's shell tool can invoke `centraid preview snapshot` by bare name.
 */

export function defaultCentraidCliDir(): string {
  return import.meta.dirname;
}
