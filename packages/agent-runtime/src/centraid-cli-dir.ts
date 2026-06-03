/*
 * Resolve the directory containing the built `centraid` CLI bin. Used by
 * the builder agent-session to inject the dist-dir onto PATH so the
 * agent's shell tool can invoke `centraid preview snapshot` by bare name.
 *
 * Chat-side agents no longer need this — they use the inline
 * `centraid_sql_*` tools registered by `runTurn`.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function defaultCentraidCliDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}
